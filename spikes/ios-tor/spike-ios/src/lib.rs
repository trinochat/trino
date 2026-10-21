//! Trino iOS spike: Tor (Arti, through trino-net) inside an iPhone app.
//!
//! A static library with a few C functions (include/spike_ios.h) that the
//! spike's app calls from Swift. Each one answers JSON, as a string the
//! caller frees with `spike_free`:
//!
//! - `spike_tor_start`: start Tor in a folder, fresh (the folder wiped
//!   first, a cold start) or not (warm);
//! - `spike_tor_status`: the state now, how long it took to be ready, and
//!   every state seen since the start;
//! - `spike_ws_probe`: a WebSocket to a relay over Tor, one read-only `REQ`
//!   and its `EOSE`. It never publishes;
//! - `spike_tor_stop`: stop Tor;
//! - `spike_note`: a timestamped note from the app (going to the
//!   background, coming back);
//! - `spike_report`: everything above, with memory and errors.
//!
//! What is measured is trino-net as the desktop runs it: `Net::with_arti`,
//! `start`, `ready`, `ws_connect` and `stop`. Nothing here is the engine's
//! design; it is thrown away once the question is answered.
//!
//! Nothing is logged to disk and no relay content is kept: a probe counts
//! the events and bytes it reads, nothing else.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use trino_net::{ws_connect, IsoKind, Net, NetConfig, NetStatus, TorDirs};

pub mod memory;

/// The relay a probe opens when the app gives none.
pub const DEFAULT_RELAY: &str = "wss://nos.lol";

/// A read-only request: the newest note, one at most. The relay answers
/// with at most one `EVENT` and then `EOSE`.
const REQ: &str = r#"["REQ","trino-spike",{"kinds":[1],"limit":1}]"#;
const CLOSE: &str = r#"["CLOSE","trino-spike"]"#;

/// The only folder name a fresh start wipes: a mistaken path can never
/// remove anything else.
pub const FOLDER_NAME: &str = "tor-spike";

/// Arti's switch for its folder permission checks (tor-config 0.47,
/// `mistrust.rs`). Only the "trust the folder" start sets it.
const MISTRUST_VAR: &str = "ARTI_FS_DISABLE_PERMISSION_CHECKS";

struct Spike {
    /// The spike's own runtime, for the status watcher and the probes.
    /// Arti runs on another one, inside trino-net.
    rt: Runtime,
    /// When the library was first called: every `t_ms` counts from here.
    born: Instant,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    net: Option<Arc<Net>>,
    watcher: Option<JoinHandle<()>>,
    /// Every start, the running one last.
    runs: Vec<Arc<Mutex<Run>>>,
    probes: Vec<Value>,
    notes: Vec<Value>,
    errors: Vec<Value>,
}

/// One start of Tor, from `spike_tor_start` to `spike_tor_stop`.
struct Run {
    n: usize,
    fresh: bool,
    trust_dirs: bool,
    t0: Instant,
    started_t_ms: u64,
    wipe_ms: Option<u64>,
    /// How long `Net::start` itself took (Arti's client made, not ready).
    start_call_ms: u64,
    /// Every state seen, with the time since the start.
    states: Vec<Value>,
    last: Option<NetStatus>,
    ready_ms: Option<u64>,
    memory_at_ready: Option<Value>,
    diagnosis: Option<Value>,
    stop_ms: Option<u64>,
    stopped_after_ms: Option<u64>,
}

impl Run {
    fn to_json(&self) -> Value {
        json!({
            "n": self.n,
            "fresh": self.fresh,
            "trustDirs": self.trust_dirs,
            "startedTMs": self.started_t_ms,
            "wipeMs": self.wipe_ms,
            "startCallMs": self.start_call_ms,
            "readyMs": self.ready_ms,
            "memoryAtReady": self.memory_at_ready,
            "last": self.last,
            "states": self.states,
            "diagnosis": self.diagnosis,
            "stopMs": self.stop_ms,
            "stoppedAfterMs": self.stopped_after_ms,
        })
    }

    /// One state from the watcher: kept unless it repeats the last one.
    fn see(&mut self, status: NetStatus) {
        if self.last == Some(status) {
            return;
        }
        let ms = ms_since(self.t0);
        self.last = Some(status);
        self.states.push(json!({ "ms": ms, "status": status }));
        if status.is_ready() && self.ready_ms.is_none() {
            self.ready_ms = Some(ms);
            self.memory_at_ready = Some(memory::snapshot());
        }
    }
}

static SPIKE: LazyLock<Spike> = LazyLock::new(|| Spike {
    rt: tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("spike")
        .enable_all()
        .build()
        .expect("the spike's runtime"),
    born: Instant::now(),
    inner: Mutex::new(Inner::default()),
});

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn ms_since(t: Instant) -> u64 {
    u64::try_from(t.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn t_ms() -> u64 {
    ms_since(SPIKE.born)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn error(inner: &mut Inner, stage: &str, text: impl Into<String>) -> Value {
    let entry = json!({ "tMs": t_ms(), "stage": stage, "error": text.into() });
    inner.errors.push(entry.clone());
    json!({ "ok": false, "error": entry })
}

/// Start Tor with `tor_home` as its folder (trino-net keeps `state/`,
/// `cache/`, `settings.json` and `run.marker` there). `fresh` wipes the
/// folder first, for a cold start; it must be named `tor-spike`.
/// `trust_dirs` turns Arti's folder permission checks off, to tell a
/// refused folder apart from anything else.
pub fn start(tor_home: &Path, fresh: bool, trust_dirs: bool) -> Value {
    let spike = &*SPIKE;
    let mut inner = lock(&spike.inner);
    if inner.net.is_some() {
        return error(&mut inner, "start", "Tor is running: stop it first");
    }
    if tor_home.file_name().and_then(|n| n.to_str()) != Some(FOLDER_NAME) {
        return error(&mut inner, "start", "the folder must be named tor-spike");
    }
    let mut wipe_ms = None;
    if fresh {
        let t = Instant::now();
        match std::fs::remove_dir_all(tor_home) {
            Ok(()) => wipe_ms = Some(ms_since(t)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => wipe_ms = Some(0),
            Err(e) => return error(&mut inner, "wipe", e.to_string()),
        }
    }
    if let Err(e) = std::fs::create_dir_all(tor_home) {
        return error(&mut inner, "folder", e.to_string());
    }
    // Before any of Arti's threads exist, so nothing reads the environment
    // while it changes.
    if trust_dirs {
        std::env::set_var(MISTRUST_VAR, "true");
    } else {
        std::env::remove_var(MISTRUST_VAR);
    }

    let net = Net::with_arti(NetConfig {
        tor_home: tor_home.to_path_buf(),
        pt: None,
    });
    let started_t_ms = t_ms();
    let t0 = Instant::now();
    net.start();
    let start_call_ms = ms_since(t0);
    let first = net.status_now();

    let run = Arc::new(Mutex::new(Run {
        n: inner.runs.len() + 1,
        fresh,
        trust_dirs,
        t0,
        started_t_ms,
        wipe_ms,
        start_call_ms,
        states: Vec::new(),
        last: None,
        ready_ms: None,
        memory_at_ready: None,
        diagnosis: None,
        stop_ms: None,
        stopped_after_ms: None,
    }));
    lock(&run).see(first);

    // A start that did not even make Arti's client ends at once in
    // "blocked, can't bootstrap, 0 %"; trino-net only says "arti" then.
    // Ask Arti itself why, with the same folders.
    if !matches!(first, NetStatus::Starting { .. }) {
        let diagnosis = diagnose(tor_home);
        lock(&run).diagnosis = Some(diagnosis.clone());
        inner
            .errors
            .push(json!({ "tMs": t_ms(), "stage": "launch", "error": diagnosis }));
    }

    let mut changes = net.status();
    let watched = Arc::clone(&run);
    let watcher = spike.rt.spawn(async move {
        loop {
            let now = *changes.borrow_and_update();
            lock(&watched).see(now);
            if changes.changed().await.is_err() {
                return;
            }
        }
    });

    let answer = json!({
        "ok": true,
        "run": lock(&run).to_json(),
        "memory": memory::snapshot(),
    });
    inner.net = Some(net);
    inner.watcher = Some(watcher);
    inner.runs.push(run);
    answer
}

/// Arti's own answer to making a client on `tor_home`'s folders, as text.
/// Only after trino-net failed to: then nothing holds those folders.
fn diagnose(tor_home: &Path) -> Value {
    use arti_client::config::TorClientConfigBuilder;
    use arti_client::{HasKind, TorClient};
    use tor_rtcompat::tokio::TokioRustlsRuntime;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let dirs = TorDirs::fixed(tor_home);
    let config = match TorClientConfigBuilder::from_directories(&dirs.state, &dirs.cache).build() {
        Ok(config) => config,
        Err(e) => return json!({ "stage": "config", "error": e.to_string() }),
    };
    SPIKE.rt.block_on(async move {
        let runtime = match TokioRustlsRuntime::current() {
            Ok(runtime) => runtime,
            Err(e) => return json!({ "stage": "runtime", "error": e.to_string() }),
        };
        match TorClient::with_runtime(runtime)
            .config(config)
            .create_unbootstrapped()
        {
            Ok(client) => {
                drop(client);
                json!({ "stage": "create", "ok": true })
            }
            Err(e) => json!({
                "stage": "create",
                "kind": format!("{:?}", e.kind()),
                "error": e.to_string(),
            }),
        }
    })
}

/// The state now, and the run so far.
pub fn status() -> Value {
    let inner = lock(&SPIKE.inner);
    let status = inner.net.as_ref().map(|net| net.status_now());
    let run = inner
        .net
        .as_ref()
        .and_then(|_| inner.runs.last())
        .map(|run| {
            let run = lock(run);
            json!({ "elapsedMs": ms_since(run.t0), "run": run.to_json() })
        });
    json!({
        "ok": true,
        "tMs": t_ms(),
        "running": inner.net.is_some(),
        "status": status,
        "current": run,
        "memory": memory::snapshot(),
    })
}

/// A WebSocket to `url` over Tor, a read-only `REQ`, and its `EOSE`,
/// within `limit` in all (waiting for Tor included). A new session, so a
/// new circuit, each time.
pub fn probe(url: &str, limit: Duration) -> Value {
    let net = lock(&SPIKE.inner).net.clone();
    let Some(net) = net else {
        return error(&mut lock(&SPIKE.inner), "probe", "Tor is not started");
    };
    let started_t_ms = t_ms();
    let status_before = net.status_now();
    let url_owned = url.to_string();
    let result = SPIKE
        .rt
        .block_on(async move { probe_on(&net, &url_owned, limit).await });
    let entry = json!({
        "tMs": started_t_ms,
        "url": url,
        "statusBefore": status_before,
        "result": result,
        "memoryAfter": memory::snapshot(),
    });
    let mut inner = lock(&SPIKE.inner);
    inner.probes.push(entry.clone());
    if result.get("ok") != Some(&Value::Bool(true)) {
        inner
            .errors
            .push(json!({ "tMs": t_ms(), "stage": "probe", "error": result }));
    }
    entry
}

async fn probe_on(net: &Net, url: &str, limit: Duration) -> Value {
    let t0 = Instant::now();
    if net.ready(limit).await.is_err() {
        return json!({ "ok": false, "stage": "ready", "waitedMs": ms_since(t0),
                       "status": net.status_now() });
    }
    let ready_wait_ms = ms_since(t0);
    let session = net.session();
    let iso = session.iso(IsoKind::RELAY, url.as_bytes());
    let left = limit.saturating_sub(t0.elapsed());
    let exchange = async {
        let t1 = Instant::now();
        let mut ws = ws_connect(net, url, &iso).await.map_err(
            |e| json!({ "stage": "connect", "error": e.to_string(), "ms": ms_since(t1) }),
        )?;
        let open_ms = ms_since(t1);
        ws.send(Message::Text(REQ.into()))
            .await
            .map_err(|e| json!({ "stage": "send", "error": e.to_string() }))?;
        let (mut events, mut bytes, mut notices) = (0u32, 0usize, 0u32);
        let mut first_message_ms = None;
        loop {
            let Some(message) = ws.next().await else {
                return Err(json!({ "stage": "read", "error": "closed before EOSE",
                                   "events": events }));
            };
            let message =
                message.map_err(|e| json!({ "stage": "read", "error": e.to_string() }))?;
            let Message::Text(text) = message else {
                if matches!(message, Message::Close(_)) {
                    return Err(json!({ "stage": "read", "error": "closed before EOSE",
                                       "events": events }));
                }
                continue;
            };
            first_message_ms.get_or_insert_with(|| ms_since(t1));
            bytes += text.len();
            if text.starts_with(r#"["EOSE""#) {
                break;
            } else if text.starts_with(r#"["EVENT""#) {
                events += 1;
            } else if text.starts_with(r#"["NOTICE""#) || text.starts_with(r#"["CLOSED""#) {
                notices += 1;
            }
        }
        let eose_ms = ms_since(t1);
        let _ = ws.send(Message::Text(CLOSE.into())).await;
        let _ = ws.close(None).await;
        Ok(json!({
            "openMs": open_ms,
            "firstMessageMs": first_message_ms,
            "eoseMs": eose_ms,
            "events": events,
            "notices": notices,
            "bytesRead": bytes,
        }))
    };
    match tokio::time::timeout(left, exchange).await {
        Ok(Ok(mut done)) => {
            done["ok"] = json!(true);
            done["readyWaitMs"] = json!(ready_wait_ms);
            done["totalMs"] = json!(ms_since(t0));
            done
        }
        Ok(Err(mut failed)) => {
            failed["ok"] = json!(false);
            failed["totalMs"] = json!(ms_since(t0));
            failed
        }
        Err(_) => json!({ "ok": false, "stage": "timeout", "totalMs": ms_since(t0),
                          "status": net.status_now() }),
    }
}

/// Stop Tor (trino-net's `stop`: Arti's runtime shut down, its files
/// closed). Blocks while it does.
pub fn stop() -> Value {
    let (net, watcher, run) = {
        let mut inner = lock(&SPIKE.inner);
        (
            inner.net.take(),
            inner.watcher.take(),
            inner.runs.last().cloned(),
        )
    };
    let Some(net) = net else {
        return error(&mut lock(&SPIKE.inner), "stop", "Tor is not started");
    };
    let t = Instant::now();
    net.stop();
    let stop_ms = ms_since(t);
    if let Some(watcher) = watcher {
        watcher.abort();
    }
    drop(net);
    let run = run.map(|run| {
        let mut run = lock(&run);
        run.stop_ms = Some(stop_ms);
        run.stopped_after_ms = Some(ms_since(run.t0));
        run.to_json()
    });
    json!({ "ok": true, "stopMs": stop_ms, "run": run, "memory": memory::snapshot() })
}

/// A note from the app, timestamped here: "background", "foreground".
pub fn note(text: &str) -> Value {
    let mut inner = lock(&SPIKE.inner);
    let status = inner.net.as_ref().map(|net| net.status_now());
    let entry = json!({
        "tMs": t_ms(),
        "unixMs": unix_ms(),
        "note": text,
        "status": status,
        "memory": memory::snapshot(),
    });
    inner.notes.push(entry.clone());
    json!({ "ok": true, "note": entry })
}

/// Everything so far.
pub fn report() -> Value {
    let inner = lock(&SPIKE.inner);
    json!({
        "ok": true,
        "spike": "trino-ios-tor",
        "build": {
            "crate": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "debugAssertions": cfg!(debug_assertions),
            "arti": "arti-client 0.47 (see Cargo.lock)",
        },
        "tMs": t_ms(),
        "unixMs": unix_ms(),
        "running": inner.net.is_some(),
        "status": inner.net.as_ref().map(|net| net.status_now()),
        "memory": memory::snapshot(),
        "runs": inner.runs.iter().map(|run| lock(run).to_json()).collect::<Vec<_>>(),
        "probes": inner.probes,
        "notes": inner.notes,
        "errors": inner.errors,
    })
}

// ---------------------------------------------------------------------------
// The C functions (include/spike_ios.h). Every one answers a JSON string
// that the caller frees with `spike_free`, never null. A panic becomes
// {"ok":false,"panic":...} instead of unwinding into Swift.

fn answer(body: impl FnOnce() -> Value) -> *mut c_char {
    let value = match catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(panic) => {
            let text = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".to_string());
            json!({ "ok": false, "panic": text })
        }
    };
    // serde_json escapes NUL, so this never fails.
    CString::new(value.to_string())
        .unwrap_or_else(|_| CString::from(c"{\"ok\":false}"))
        .into_raw()
}

/// # Safety
/// `text` is null or a NUL-terminated string that lives for the call.
unsafe fn text_arg(text: *const c_char) -> Option<String> {
    if text.is_null() {
        None
    } else {
        Some(CStr::from_ptr(text).to_string_lossy().into_owned())
    }
}

/// # Safety
/// `tor_home` is a NUL-terminated path that lives for the call.
#[no_mangle]
pub unsafe extern "C" fn spike_tor_start(
    tor_home: *const c_char,
    fresh: bool,
    trust_dirs: bool,
) -> *mut c_char {
    let tor_home = text_arg(tor_home);
    answer(move || match tor_home {
        Some(path) => start(&PathBuf::from(path), fresh, trust_dirs),
        None => json!({ "ok": false, "error": "no folder" }),
    })
}

#[no_mangle]
pub extern "C" fn spike_tor_status() -> *mut c_char {
    answer(status)
}

/// # Safety
/// `url` is null (the default relay) or a NUL-terminated string that
/// lives for the call.
#[no_mangle]
pub unsafe extern "C" fn spike_ws_probe(url: *const c_char, limit_secs: u32) -> *mut c_char {
    let url = text_arg(url).unwrap_or_else(|| DEFAULT_RELAY.to_string());
    let limit = Duration::from_secs(u64::from(limit_secs.clamp(5, 300)));
    answer(move || probe(&url, limit))
}

#[no_mangle]
pub extern "C" fn spike_tor_stop() -> *mut c_char {
    answer(stop)
}

/// # Safety
/// `text` is null or a NUL-terminated string that lives for the call.
#[no_mangle]
pub unsafe extern "C" fn spike_note(text: *const c_char) -> *mut c_char {
    let text = text_arg(text).unwrap_or_default();
    answer(move || note(&text))
}

#[no_mangle]
pub extern "C" fn spike_report() -> *mut c_char {
    answer(report)
}

/// # Safety
/// `json` is null or a string one of the functions above returned, freed
/// once.
#[no_mangle]
pub unsafe extern "C" fn spike_free(json: *mut c_char) {
    if !json.is_null() {
        drop(CString::from_raw(json));
    }
}

#[cfg(test)]
mod tests;
