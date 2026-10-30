//! P1's mailboxes in the engine (P1-7, design P1 §3.5-§3.8): the network
//! time and its epochs, the routing table of the epoch, the padding of the
//! list a relay is asked for, when that list is renewed, the duplicate
//! markers, and what of all this is kept on disk.
//!
//! The derivations themselves (seeds, the session chain, the mailbox keys)
//! are trino-core's `p1::mailbox`; this module decides which of them a
//! session listens to and sends to, and when. Nothing in here opens a
//! connection: the relays are driven by whoever holds the session, with
//! the plans these functions give.

pub mod clock;
