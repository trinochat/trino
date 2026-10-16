//! A call as the chat history keeps it (K13). What the app does with the
//! call log (recording, listing, expiring) is still in its call_log.rs.

use serde::{Deserialize, Serialize};

/// Who placed the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallDirection {
    Outgoing,
    Incoming,
}

/// How the call ended (W6, `call-outcome.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallOutcome {
    Answered,
    Missed,
    Declined,
    Unanswered,
    Cancelled,
    Failed,
}

/// One call, as the chat history keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallEvent {
    pub id: String,
    pub direction: CallDirection,
    pub video: bool,
    pub outcome: CallOutcome,
    pub duration_sec: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
}
