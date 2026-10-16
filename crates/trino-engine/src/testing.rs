//! What tests share: the engine's own, and the app's through the
//! `test-util` feature.

use std::path::Path;
use std::sync::Arc;
use trino_net::mock::{FakeTor, Forbidden, Mock};
use trino_net::{Net, NetConfig, TorBackend};

/// A `Net` whose Tor is a `FakeTor` with its folder at `tor_home`, and
/// whose direct transport fails the test if touched.
pub fn fake_tor(tor_home: &Path) -> (Arc<Net>, Arc<FakeTor>, Arc<Mock>) {
    let mock = Mock::new();
    let fake = FakeTor::new(Arc::clone(&mock));
    let net = Net::with_backend(
        NetConfig {
            tor_home: tor_home.to_path_buf(),
            pt: None,
        },
        Arc::clone(&fake) as Arc<dyn TorBackend>,
        Arc::new(Forbidden),
    );
    (net, fake, mock)
}
