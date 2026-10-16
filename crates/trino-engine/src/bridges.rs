//! The private bridge lines the store keeps (Tor design §2.5, M4-0c): read
//! at unlock, and the first run's sealed once the account exists. Choosing
//! and showing them stay the app's (bridges_cmds.rs).

use crate::command_error::CommandError;
pub use crate::prefs::NET_BRIDGES;
use crate::state::InnerState;
use trino_net::tor::bridges::{self, BridgeLine, Bridges};
use trino_net::Net;
use zeroize::Zeroizing;

/// The private lines kept under `net.bridges`, if they are bridges.
pub fn stored_lines(stored: Option<&str>) -> Option<Vec<BridgeLine>> {
    bridges::parse_pasted(stored?).ok()
}

/// The private lines in a `prefs.bin` as `load_session` read it.
pub fn stored_in(prefs: Option<&serde_json::Value>) -> Option<Vec<BridgeLine>> {
    stored_lines(prefs?.get(NET_BRIDGES)?.as_str())
}

/// The first run's private lines, sealed in the account just made.
pub fn keep_first_run_lines(inner: &InnerState, net: &Net) -> Result<(), CommandError> {
    let Bridges::Private(lines) = net.bridges() else {
        return Ok(());
    };
    if crate::prefs::current_map(inner).contains_key(NET_BRIDGES) {
        return Ok(());
    }
    let kept = Zeroizing::new(bridges::to_stored(&lines));
    crate::prefs::set_backend_pref(inner, NET_BRIDGES, Some(&kept))
}
