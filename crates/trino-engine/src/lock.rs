//! Why Trino locked (cifrado local CL-6a), kept while locked so the window
//! opened after the lock can say so. Locking itself is the app's
//! (lock_cmds.rs).

use serde::{Deserialize, Serialize};

/// What made the system lock Trino.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemCause {
    /// Windows was locked, the session switched or disconnected.
    Session,
    /// The computer went to sleep or hibernated.
    Suspend,
}

/// Why Trino locked, as the unlock screen says it (`LockReason` of
/// src/screens/types.ts, but for the cold start, which is the frontend's).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LockReason {
    Manual,
    Idle { minutes: u32 },
    System { cause: SystemCause },
}
