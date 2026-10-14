//! Bridge lines (Tor design §5.2; TOR-7): what a pasted line must be, and
//! the built-in bridges of Tor Browser. No network.

use crate::tor::bridges::{self, BridgeError, BridgeLine, MAX_ARGUMENTS, MAX_LINES};
use crate::TransportKind;

const OBFS4: &str = "obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 \
                     cert=YXJlIGZyZXF1ZW50bHkgZnVsbCBvZiBsaXR0bGUgbWVzc2FnZXMgeW91IGNhbiBmaW5kLg iat-mode=0";
const WEBTUNNEL: &str = "webtunnel [2001:db8::1]:443 0123456789ABCDEF0123456789ABCDEF01234567 \
                         url=https://bridge.example/secret-path ver=0.0.1";

fn one(line: &str) -> Result<BridgeLine, BridgeError> {
    line.parse::<BridgeLine>()
}

fn error_of(line: &str) -> BridgeError {
    one(line).expect_err(line)
}

// ---- Design test 23: pasted lines are parsed strictly ----

#[test]
fn bridge_lines_are_parsed_strictly() {
    // The forms bridges.torproject.org, its e-mail and its Telegram bot
    // hand out, with or without the word "Bridge" Tor's torrc uses.
    let obfs4 = one(OBFS4).unwrap();
    assert_eq!(obfs4.transport(), TransportKind::Obfs4);
    assert_eq!(obfs4.protocol(), "obfs4");
    assert_eq!(
        obfs4.as_str(),
        OBFS4.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    let with_word = one(&format!("Bridge {OBFS4}")).unwrap();
    assert_eq!(with_word.as_str(), obfs4.as_str(), "the word is dropped");
    assert_eq!(one(&format!("  bridge\t{OBFS4}  ")).unwrap(), obfs4);

    let webtunnel = one(WEBTUNNEL).unwrap();
    assert_eq!(webtunnel.transport(), TransportKind::Webtunnel);
    assert_eq!(webtunnel.protocol(), "webtunnel");

    let meek = one(
        "meek_lite 192.0.2.20:80 0123456789ABCDEF0123456789ABCDEF01234567 \
                    url=https://cdn.example/ front=www.example.com",
    )
    .unwrap();
    assert_eq!(meek.transport(), TransportKind::Meek);
    assert_eq!(meek.protocol(), "meek_lite");

    // The transport: one of lyrebird's, by its name.
    assert_eq!(error_of(""), BridgeError::Empty);
    assert_eq!(error_of("Bridge"), BridgeError::Empty);
    assert_eq!(
        error_of(&OBFS4.replacen("obfs4", "obfs3", 1)),
        BridgeError::UnknownTransport
    );
    assert_eq!(
        error_of(&OBFS4.replacen("obfs4", "OBFS4", 1)),
        BridgeError::UnknownTransport
    );
    // A bridge with no transport hides nothing from a censor (§5.2).
    assert_eq!(
        error_of("192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567"),
        BridgeError::UnknownTransport
    );

    // The address: an IP and a port, never a name to resolve.
    for address in [
        "bridge.example:443",
        "192.0.2.10",
        "192.0.2.10:0",
        "192.0.2.10:70000",
        "[2001:db8::1]",
    ] {
        assert_eq!(
            error_of(&OBFS4.replacen("192.0.2.10:443", address, 1)),
            BridgeError::BadAddress,
            "{address}"
        );
    }

    // The fingerprint: forty hex digits, which Arti needs (spike S3).
    assert_eq!(
        error_of("obfs4 192.0.2.10:443 cert=abc iat-mode=0"),
        BridgeError::NoFingerprint
    );
    for fingerprint in [
        "0123456789ABCDEF",
        "0123456789ABCDEF0123456789ABCDEF0123456G",
    ] {
        assert_eq!(
            error_of(&OBFS4.replacen("0123456789ABCDEF0123456789ABCDEF01234567", fingerprint, 1)),
            BridgeError::BadFingerprint,
            "{fingerprint}"
        );
    }

    // The arguments: key=value, each key once, printable, and what obfs4,
    // WebTunnel and meek need.
    for bad in [
        "cert=",
        "=abc",
        "ce rt",
        "cert=a\u{7}b",
        "iat-mode=0 iat-mode=1",
    ] {
        let line = format!("{OBFS4} {bad}");
        assert_eq!(error_of(&line), BridgeError::BadArgument, "{bad}");
    }
    assert_eq!(
        error_of(&OBFS4.replace(" iat-mode=0", "")),
        BridgeError::MissingArgument
    );
    assert_eq!(
        error_of(&OBFS4.replace(" iat-mode=0", " iat-mode=3")),
        BridgeError::BadArgument
    );
    assert_eq!(
        error_of(&WEBTUNNEL.replace("url=https://", "url=http://")),
        BridgeError::BadArgument
    );
    assert_eq!(
        error_of(&WEBTUNNEL.replace(" url=https://bridge.example/secret-path", "")),
        BridgeError::MissingArgument
    );

    // Arguments go to the transport as a SOCKS5 user and password: 510
    // bytes at most (§5.2).
    let room = MAX_ARGUMENTS - "cert=x;iat-mode=0;pad=".len();
    let fits = format!("{OBFS4} pad={}", "a".repeat(room)).replace(
        "cert=YXJlIGZyZXF1ZW50bHkgZnVsbCBvZiBsaXR0bGUgbWVzc2FnZXMgeW91IGNhbiBmaW5kLg",
        "cert=x",
    );
    assert!(one(&fits).is_ok());
    let over = fits.replacen("pad=", "pad=a", 1);
    assert_eq!(error_of(&over), BridgeError::ArgumentsTooLong);
}

#[test]
fn a_bridge_line_never_shows_itself_in_debug() {
    let line = one(OBFS4).unwrap();
    let shown = format!("{line:?}");
    assert!(!shown.contains("192.0.2.10"), "{shown}");
    assert!(!shown.contains("cert="), "{shown}");
    assert!(shown.contains("obfs4"), "{shown}");
    let shown = format!("{:?}", bridges::Bridges::Private(vec![line]));
    assert!(!shown.contains("192.0.2.10"), "{shown}");
}

#[test]
fn pasted_text_gives_every_line_or_every_error_with_its_place() {
    let text = format!("\n# from bridges.torproject.org\nBridge {OBFS4}\r\n\n{WEBTUNNEL}\n");
    let lines = bridges::parse_pasted(&text).unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].transport(), TransportKind::Obfs4);
    assert_eq!(lines[1].transport(), TransportKind::Webtunnel);

    // The same bridge twice is one.
    let twice = format!("{OBFS4}\nBridge {OBFS4}");
    assert_eq!(bridges::parse_pasted(&twice).unwrap().len(), 1);

    // Every bad line, by its line number (from 1), and nothing kept.
    let mixed = format!("{OBFS4}\nobfs3 1.2.3.4:5 x\n\n{WEBTUNNEL}\nnot a bridge");
    let errors = bridges::parse_pasted(&mixed).unwrap_err();
    assert_eq!(
        errors,
        [
            (2, BridgeError::UnknownTransport),
            (5, BridgeError::UnknownTransport)
        ]
    );

    // Nothing at all is an error too.
    assert_eq!(
        bridges::parse_pasted(" \n# only a comment\n").unwrap_err(),
        [(0, BridgeError::Empty)]
    );

    // At most 20 lines (§5.2).
    let many: Vec<String> = (0..=MAX_LINES)
        .map(|n| OBFS4.replacen("192.0.2.10:443", &format!("192.0.2.10:{}", 1000 + n), 1))
        .collect();
    assert_eq!(
        bridges::parse_pasted(&many[..MAX_LINES].join("\n"))
            .unwrap()
            .len(),
        MAX_LINES
    );
    assert_eq!(
        bridges::parse_pasted(&many.join("\n")).unwrap_err(),
        [(0, BridgeError::TooMany)]
    );
}

#[test]
fn the_lines_kept_in_the_store_read_back_as_they_were() {
    let lines = bridges::parse_pasted(&format!("{OBFS4}\n{WEBTUNNEL}")).unwrap();
    let kept = bridges::to_stored(&lines);
    assert_eq!(bridges::parse_pasted(&kept).unwrap(), lines);
}

#[test]
fn every_accepted_line_is_one_arti_takes() {
    for line in [OBFS4, WEBTUNNEL] {
        let line = one(line).unwrap();
        assert!(
            line.as_str()
                .parse::<arti_client::config::BridgeConfigBuilder>()
                .is_ok_and(|bridge| bridge.build().is_ok()),
            "{}",
            line.protocol()
        );
    }
}

// ---- Design test 24: the built-in bridges are Tor Browser's ----

/// The `bridges` of Tor Browser's pt_config.json (tor/pt_config.json, a
/// copy of the Expert Bundle's, which scripts/fetch-lyrebird.sh refreshes).
fn tor_browser(kind: &str) -> Vec<String> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("tor/pt_config.json")).unwrap();
    config["bridges"][kind]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn builtin_bridges_match_the_tor_browser_config() {
    for (kind, name) in [
        (TransportKind::Obfs4, "obfs4"),
        (TransportKind::Snowflake, "snowflake"),
    ] {
        let builtin = bridges::builtin(kind);
        let shown: Vec<&str> = builtin.iter().map(BridgeLine::as_str).collect();
        assert_eq!(shown, tor_browser(name), "{name}");
        assert!(builtin.iter().all(|line| line.transport() == kind));
    }
    assert_eq!(bridges::builtin(TransportKind::Obfs4).len(), 7);
    assert_eq!(bridges::builtin(TransportKind::Snowflake).len(), 2);
    // Tor Browser's meek line has no fingerprint, which Arti refuses
    // (spike S3); there is no built-in WebTunnel; and no bridge is none.
    assert_eq!(tor_browser("meek").len(), 1);
    assert!(bridges::builtin(TransportKind::Meek).is_empty());
    assert!(bridges::builtin(TransportKind::Webtunnel).is_empty());
    assert!(bridges::builtin(TransportKind::None).is_empty());
    assert_eq!(
        bridges::BUILTIN,
        [TransportKind::Snowflake, TransportKind::Obfs4],
        "the order the panel tries them in (§5.3, without meek)"
    );
}

#[test]
fn which_bridges_a_start_uses() {
    use bridges::Bridges;
    assert!(Bridges::None.lines().is_empty());
    assert_eq!(Bridges::None.transport(), TransportKind::None);
    let builtin = Bridges::Builtin(TransportKind::Snowflake);
    assert_eq!(builtin.lines().len(), 2);
    assert_eq!(builtin.transport(), TransportKind::Snowflake);
    assert!(!builtin.is_private());

    let private =
        Bridges::Private(bridges::parse_pasted(&format!("{OBFS4}\n{WEBTUNNEL}")).unwrap());
    assert!(private.is_private());
    assert_eq!(private.lines().len(), 2);
    // The slowest of its kinds, for the limit without progress (R-23).
    assert_eq!(private.transport(), TransportKind::Obfs4);
    assert_eq!(private.protocols(), ["obfs4", "webtunnel"]);
    let snowflake = Bridges::Private(vec![
        one(OBFS4).unwrap(),
        bridges::builtin(TransportKind::Snowflake).remove(0),
    ]);
    assert_eq!(snowflake.transport(), TransportKind::Snowflake);
}
