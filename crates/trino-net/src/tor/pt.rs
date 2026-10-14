//! lyrebird, launched by Trino itself (Tor design §5.1; spike S2, S13).
//!
//! Arti can run a bridge program itself, but on Windows it does so without
//! `CREATE_NO_WINDOW`, so a console shows lyrebird's path (S2), and
//! dropping Arti's runtime leaves lyrebird running, because a thread of
//! Arti's own holds its input (S13). So Trino runs it:
//!
//! - before each launch the program's SHA-256 is checked against the one
//!   the build pinned, with the file held open so that it cannot be
//!   changed or removed between the check and the launch (R-24). A
//!   program that is not there, or not the one shipped, is never run:
//!   the state is "bridge program missing" (R-22);
//! - it runs with no window, speaks the managed-transport protocol on its
//!   output (pt-spec: `VERSION 1`, `CMETHOD <name> socks5 <addr>`,
//!   `CMETHODS DONE`), and Arti gets each SOCKS port as an unmanaged
//!   transport (`proxy_addr`);
//! - stopping closes its input, which it leaves on
//!   (`TOR_PT_EXIT_ON_STDIN_CLOSE`), and kills it if it has not within two
//!   seconds. `Net` stops it with Tor: at lock, quit and "Borrar todo".
//!
//! Nothing it writes on its output is kept or logged; it gets no logging
//! options, so it writes no log of its own (R-25).

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// How long a launch waits for lyrebird to say where it listens. It
/// answers at once (S2); this only bounds one that hangs.
pub(crate) const HANDSHAKE: Duration = Duration::from_secs(15);

/// How long `stop` lets it leave on its own before killing it.
const LEAVE: Duration = Duration::from_secs(2);

/// Why the bridge program did not start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PtError {
    /// It is not there (or cannot be opened): Defender may have taken it.
    Missing,
    /// It is not the program this build shipped (R-24).
    Mismatch,
    /// Windows would not start it.
    Spawn,
    /// It said something that is not the protocol, or not what was asked.
    Protocol(&'static str),
    /// It did not say where it listens in time.
    Timeout,
}

/// One transport the bridge program runs, and where its SOCKS port is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtMethod {
    /// The transport's name, as bridge lines and Arti call it.
    pub protocol: String,
    /// Its SOCKS5 port, on this computer.
    pub socks: SocketAddr,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The program at `path`, open for reading only, and on Windows sharing
/// nothing but reading: until the handle goes, nobody can write it,
/// rename it or remove it, and starting it still works (R-24). Elsewhere
/// an open file stops nothing; the check is the same.
pub(crate) fn hold(path: &Path) -> io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path)
}

fn sha256_of(file: &mut File) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&buffer[..read]);
    }
}

/// Reads the managed-transport handshake from `lines` until `CMETHODS
/// DONE`: a SOCKS5 port on this computer for each of `protocols`. Lines it
/// does not know (`LOG`, `STATUS`, anything else) are skipped, as pt-spec
/// asks.
pub(crate) fn read_handshake(
    lines: impl IntoIterator<Item = String>,
    protocols: &[&str],
) -> Result<Vec<PtMethod>, PtError> {
    let mut version = false;
    let mut methods: Vec<PtMethod> = Vec::new();
    for line in lines {
        let mut words = line.split_ascii_whitespace();
        match words.next() {
            Some("VERSION") => version = words.next() == Some("1"),
            Some("VERSION-ERROR") => return Err(PtError::Protocol("version")),
            Some("ENV-ERROR") => return Err(PtError::Protocol("environment")),
            Some("PROXY-ERROR") => return Err(PtError::Protocol("proxy")),
            Some("CMETHOD-ERROR") => return Err(PtError::Protocol("transport")),
            Some("CMETHOD") => {
                let (Some(name), Some(kind), Some(address)) =
                    (words.next(), words.next(), words.next())
                else {
                    return Err(PtError::Protocol("transport"));
                };
                let socks = address
                    .parse::<SocketAddr>()
                    .ok()
                    .filter(|socks| kind == "socks5" && socks.ip().is_loopback())
                    .ok_or(PtError::Protocol("address"))?;
                if protocols.contains(&name) && methods.iter().all(|m| m.protocol != name) {
                    methods.push(PtMethod {
                        protocol: name.to_string(),
                        socks,
                    });
                }
            }
            Some("CMETHODS") if words.next() == Some("DONE") => {
                if !version {
                    return Err(PtError::Protocol("version"));
                }
                // In the order asked for, every one of them.
                let mut ordered = Vec::with_capacity(protocols.len());
                for protocol in protocols {
                    let method = methods
                        .iter()
                        .find(|m| m.protocol == *protocol)
                        .ok_or(PtError::Protocol("transport"))?;
                    ordered.push(method.clone());
                }
                return Ok(ordered);
            }
            _ => {}
        }
    }
    Err(PtError::Protocol("exited"))
}

/// A running bridge program.
pub struct PtProcess {
    child: Mutex<Child>,
    /// Its input: closing it asks it to leave.
    input: Mutex<Option<ChildStdin>>,
    methods: Vec<PtMethod>,
}

impl PtProcess {
    /// Run the program at `path` for `protocols`, with its state in
    /// `state`, if its SHA-256 is `sha256`; `args` only for tests (the
    /// real one gets none). Returns once it said where it listens.
    pub(crate) fn launch(
        path: &Path,
        sha256: &[u8; 32],
        args: &[OsString],
        protocols: &[&str],
        state: &Path,
        handshake: Duration,
    ) -> Result<PtProcess, PtError> {
        let mut held = hold(path).map_err(|_| PtError::Missing)?;
        if sha256_of(&mut held).map_err(|_| PtError::Missing)? != *sha256 {
            return Err(PtError::Mismatch);
        }
        std::fs::create_dir_all(state).map_err(|_| PtError::Spawn)?;
        let mut command = Command::new(path);
        command
            .args(args)
            .env("TOR_PT_MANAGED_TRANSPORT_VER", "1")
            .env("TOR_PT_STATE_LOCATION", state)
            .env("TOR_PT_CLIENT_TRANSPORTS", protocols.join(","))
            .env("TOR_PT_EXIT_ON_STDIN_CLOSE", "1")
            .env_remove("TOR_PT_PROXY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window (S2).
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|_| PtError::Spawn)?;
        // Started from the file that was checked: it may go now.
        drop(held);

        let input = child.stdin.take();
        let output = child.stdout.take();
        let mut process = PtProcess {
            child: Mutex::new(child),
            input: Mutex::new(input),
            methods: Vec::new(),
        };
        let Some(output) = output else {
            process.stop();
            return Err(PtError::Spawn);
        };
        // Its output, line by line, on a thread of its own that keeps
        // reading (and dropping) until it ends, so the pipe never fills.
        let (lines, received) = mpsc::channel();
        let reader = std::thread::Builder::new()
            .name("lyrebird-output".to_string())
            .spawn(move || {
                for line in BufReader::new(output).lines() {
                    let Ok(line) = line else { return };
                    // Once the handshake is read, nobody listens.
                    let _ = lines.send(line);
                }
            });
        if reader.is_err() {
            process.stop();
            return Err(PtError::Spawn);
        }

        let deadline = Instant::now() + handshake;
        let mut timed_out = false;
        let incoming = std::iter::from_fn(|| {
            let left = deadline.saturating_duration_since(Instant::now());
            match received.recv_timeout(left) {
                Ok(line) => Some(line),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    timed_out = true;
                    None
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => None,
            }
        });
        let read = read_handshake(incoming, protocols);
        match read {
            Ok(methods) => {
                process.methods = methods;
                Ok(process)
            }
            Err(error) => {
                process.stop();
                Err(if timed_out { PtError::Timeout } else { error })
            }
        }
    }

    /// Each transport's SOCKS port, in the order asked for.
    pub fn methods(&self) -> &[PtMethod] {
        &self.methods
    }

    /// Whether it has left.
    pub fn has_exited(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(Some(_)))
    }

    /// Ask it to leave by closing its input, and kill it if it has not
    /// within two seconds. Returns once it is gone. A second call does
    /// nothing.
    pub fn stop(&self) {
        drop(lock(&self.input).take());
        let mut child = lock(&self.child);
        let deadline = Instant::now() + LEAVE;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for PtProcess {
    fn drop(&mut self) {
        self.stop();
    }
}
