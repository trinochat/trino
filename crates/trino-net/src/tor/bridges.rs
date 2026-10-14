//! Bridges (Tor design §5.2): the built-in ones, which are Tor Browser's,
//! and the lines a person pastes, checked strictly before anything keeps
//! or uses them.
//!
//! - Built-in: the obfs4 and Snowflake bridges of Tor Browser's
//!   pt_config.json (tor/pt_config.json, a copy of the Expert Bundle's that
//!   scripts/fetch-lyrebird.sh refreshes). Its meek line has no
//!   fingerprint, which Arti refuses (spike S3), and there is no built-in
//!   WebTunnel: neither is offered.
//! - Pasted: from bridges.torproject.org, its e-mail or @GetBridgesBot. One
//!   of lyrebird's transports, an IP and port, a fingerprint and the
//!   transport's arguments, at most 510 bytes of them (a SOCKS5 user and
//!   password) and at most 20 lines. Arti's own parser must take it too.
//!   They are the person's private bridges: the app keeps them in its
//!   encrypted store, never in tor/settings.json (R-25), and Tor runs them
//!   in a folder of its own for the session (R-01).
//!
//! A line never shows itself in `Debug` or in an error: only its transport.

use crate::TransportKind;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::OnceLock;
use zeroize::Zeroize;

/// The most lines a person may paste (§5.2).
pub const MAX_LINES: usize = 20;

/// The most bytes a line's arguments may take, as the transport gets them:
/// `key=value` joined by `;`, the SOCKS5 user and password, 255 each.
pub const MAX_ARGUMENTS: usize = 510;

/// The longest line taken at all.
const MAX_LINE: usize = 2048;

/// The built-in transports, in the order "Probar con un puente" tries them
/// (§5.3, without meek since the spike).
pub const BUILTIN: [TransportKind; 2] = [TransportKind::Snowflake, TransportKind::Obfs4];

/// Why a line is not a bridge Trino takes. The UI words each one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BridgeError {
    /// Nothing there.
    Empty,
    /// Longer than any bridge line.
    TooLong,
    /// Not one of lyrebird's transports (obfs4, snowflake, webtunnel,
    /// meek_lite), or no transport at all.
    UnknownTransport,
    /// Not an IP and a port.
    BadAddress,
    /// No fingerprint, which Arti needs.
    NoFingerprint,
    /// A fingerprint that is not forty hexadecimal digits.
    BadFingerprint,
    /// An argument that is not `key=value`, is there twice, or has a value
    /// the transport does not take.
    BadArgument,
    /// An argument the transport needs is not there.
    MissingArgument,
    /// The arguments are over `MAX_ARGUMENTS`.
    ArgumentsTooLong,
    /// Arti's own parser refuses it.
    Rejected,
    /// More than `MAX_LINES` lines.
    TooMany,
}

/// One bridge line, checked: the transport's name, the address, the
/// fingerprint and the arguments, separated by single spaces, without the
/// word "Bridge". Wiped from memory when dropped.
#[derive(Clone, PartialEq, Eq)]
pub struct BridgeLine {
    transport: TransportKind,
    text: String,
}

impl BridgeLine {
    pub fn transport(&self) -> TransportKind {
        self.transport
    }

    /// The name lyrebird and Arti know the transport by.
    pub fn protocol(&self) -> &'static str {
        protocol_of(self.transport)
    }

    /// The line, as Arti and the store take it.
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl fmt::Debug for BridgeLine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BridgeLine({})", self.protocol())
    }
}

impl Drop for BridgeLine {
    fn drop(&mut self) {
        self.text.zeroize();
    }
}

/// The name of a bridge transport in lyrebird and Arti; "" for none.
pub fn protocol_of(transport: TransportKind) -> &'static str {
    match transport {
        TransportKind::None => "",
        TransportKind::Obfs4 => "obfs4",
        TransportKind::Snowflake => "snowflake",
        TransportKind::Webtunnel => "webtunnel",
        TransportKind::Meek => "meek_lite",
    }
}

fn transport_named(name: &str) -> Option<TransportKind> {
    Some(match name {
        "obfs4" => TransportKind::Obfs4,
        "snowflake" => TransportKind::Snowflake,
        "webtunnel" => TransportKind::Webtunnel,
        "meek_lite" => TransportKind::Meek,
        _ => return None,
    })
}

/// The arguments each transport cannot do without.
fn required(transport: TransportKind) -> &'static [&'static str] {
    match transport {
        TransportKind::Obfs4 => &["cert", "iat-mode"],
        TransportKind::Webtunnel | TransportKind::Meek => &["url"],
        TransportKind::Snowflake | TransportKind::None => &[],
    }
}

fn is_fingerprint(word: &str) -> bool {
    word.len() == 40 && word.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_value(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_graphic())
}

/// A value its transport would not take: obfs4's `iat-mode` is 0, 1 or 2,
/// and the `url` of WebTunnel and meek is https.
fn value_fits(transport: TransportKind, key: &str, value: &str) -> bool {
    match (transport, key) {
        (TransportKind::Obfs4, "iat-mode") => matches!(value, "0" | "1" | "2"),
        (TransportKind::Webtunnel | TransportKind::Meek, "url") => value.starts_with("https://"),
        _ => true,
    }
}

impl FromStr for BridgeLine {
    type Err = BridgeError;

    fn from_str(line: &str) -> Result<Self, Self::Err> {
        if line.len() > MAX_LINE {
            return Err(BridgeError::TooLong);
        }
        let mut words = line.split_ascii_whitespace().peekable();
        if words
            .peek()
            .is_some_and(|word| word.eq_ignore_ascii_case("bridge"))
        {
            words.next();
        }
        let name = words.next().ok_or(BridgeError::Empty)?;
        let transport = transport_named(name).ok_or(BridgeError::UnknownTransport)?;

        let address = words.next().ok_or(BridgeError::BadAddress)?;
        match address.parse::<SocketAddr>() {
            Ok(addr) if addr.port() != 0 => {}
            _ => return Err(BridgeError::BadAddress),
        }

        let fingerprint = words.next().ok_or(BridgeError::NoFingerprint)?;
        if fingerprint.contains('=') {
            return Err(BridgeError::NoFingerprint);
        }
        if !is_fingerprint(fingerprint) {
            return Err(BridgeError::BadFingerprint);
        }

        let mut keys = BTreeSet::new();
        let mut arguments = Vec::new();
        for word in words {
            let (key, value) = word.split_once('=').ok_or(BridgeError::BadArgument)?;
            if !is_key(key)
                || !is_value(value)
                || !keys.insert(key)
                || !value_fits(transport, key, value)
            {
                return Err(BridgeError::BadArgument);
            }
            arguments.push(word);
        }
        if required(transport).iter().any(|key| !keys.contains(key)) {
            return Err(BridgeError::MissingArgument);
        }
        // As the transport gets them: `key=value;key=value`.
        let joined =
            arguments.iter().map(|a| a.len()).sum::<usize>() + arguments.len().saturating_sub(1);
        if joined > MAX_ARGUMENTS {
            return Err(BridgeError::ArgumentsTooLong);
        }

        let mut text = [name, address, fingerprint].join(" ");
        for argument in &arguments {
            text.push(' ');
            text.push_str(argument);
        }
        // Arti must take it as well, or it would fail only at the start.
        let taken = text
            .parse::<arti_client::config::BridgeConfigBuilder>()
            .is_ok_and(|bridge| bridge.build().is_ok());
        if !taken {
            text.zeroize();
            return Err(BridgeError::Rejected);
        }
        Ok(BridgeLine { transport, text })
    }
}

/// The lines of pasted text: blank lines and `#` comments are skipped, and
/// the same bridge twice is one. Either every line, or every error with
/// the number of its line (from 1; 0 for the text as a whole).
pub fn parse_pasted(text: &str) -> Result<Vec<BridgeLine>, Vec<(usize, BridgeError)>> {
    let mut lines: Vec<BridgeLine> = Vec::new();
    let mut errors = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match line.parse::<BridgeLine>() {
            Ok(bridge) if lines.contains(&bridge) => {}
            Ok(bridge) => lines.push(bridge),
            Err(error) => errors.push((index + 1, error)),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    if lines.is_empty() {
        return Err(vec![(0, BridgeError::Empty)]);
    }
    if lines.len() > MAX_LINES {
        return Err(vec![(0, BridgeError::TooMany)]);
    }
    Ok(lines)
}

/// The lines as the store keeps them: one per line, which `parse_pasted`
/// reads back.
pub fn to_stored(lines: &[BridgeLine]) -> String {
    lines
        .iter()
        .map(BridgeLine::as_str)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tor Browser's bridges, from its pt_config.json.
fn tor_browser() -> &'static [BridgeLine] {
    static LINES: OnceLock<Vec<BridgeLine>> = OnceLock::new();
    LINES.get_or_init(|| {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("pt_config.json")).unwrap_or_default();
        BUILTIN
            .iter()
            .flat_map(|&kind| {
                config["bridges"][protocol_of(kind)]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|line| line.as_str()?.parse::<BridgeLine>().ok())
            .collect()
    })
}

/// The built-in bridges of `kind`: Tor Browser's obfs4 and Snowflake ones;
/// none for meek, WebTunnel or no bridge.
pub fn builtin(kind: TransportKind) -> Vec<BridgeLine> {
    tor_browser()
        .iter()
        .filter(|line| line.transport() == kind)
        .cloned()
        .collect()
}

/// The bridges a start of Tor uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Bridges {
    /// Straight to the Tor network.
    #[default]
    None,
    /// The built-in bridges of a transport (tor/settings.json).
    Builtin(TransportKind),
    /// The person's own lines, from the encrypted store: Tor runs them in
    /// a folder of its own for the session (R-01).
    Private(Vec<BridgeLine>),
}

impl Bridges {
    /// The lines to give Arti.
    pub fn lines(&self) -> Vec<BridgeLine> {
        match self {
            Bridges::None => Vec::new(),
            Bridges::Builtin(kind) => builtin(*kind),
            Bridges::Private(lines) => lines.clone(),
        }
    }

    /// The transport a start counts its limit without progress by (R-23):
    /// with private lines of several kinds, the slowest; the first of them
    /// when they are as slow.
    pub fn transport(&self) -> TransportKind {
        match self {
            Bridges::None => TransportKind::None,
            Bridges::Builtin(kind) => *kind,
            Bridges::Private(lines) => lines.iter().map(BridgeLine::transport).fold(
                TransportKind::None,
                |slowest, kind| {
                    if kind.no_progress_limit() > slowest.no_progress_limit() {
                        kind
                    } else {
                        slowest
                    }
                },
            ),
        }
    }

    pub fn is_private(&self) -> bool {
        matches!(self, Bridges::Private(_))
    }

    /// The transports lyrebird must run for these lines, each once, in
    /// the order they first appear.
    pub fn protocols(&self) -> Vec<&'static str> {
        let mut protocols = Vec::new();
        for line in self.lines() {
            if !protocols.contains(&line.protocol()) {
                protocols.push(line.protocol());
            }
        }
        protocols
    }
}
