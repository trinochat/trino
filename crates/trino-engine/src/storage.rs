//! Where the open session keeps its data (cifrado local CL-1b, design §12.3
//! and §13): the account, saved in one write.

use crate::group::GroupRoster;
use crate::state::{FriendRecord, GroupInvite, InnerState};
use crate::store::session::AccountFile;

/// The account as `account.bin` keeps it: the profile, the contacts, the
/// blocked contacts, the groups and the invitations.
pub fn account_of(inner: &InnerState) -> AccountFile {
    let mut friends: Vec<FriendRecord> = inner.friends.values().cloned().collect();
    friends.sort_by(|a, b| a.handle.cmp(&b.handle));
    let mut blocked: Vec<String> = inner.blocked.iter().cloned().collect();
    blocked.sort();
    let mut groups: Vec<GroupRoster> = inner.groups.values().cloned().collect();
    groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    let mut group_invites: Vec<GroupInvite> = inner.group_invites.values().cloned().collect();
    group_invites.sort_by_key(|invite| invite.received_at);
    AccountFile {
        handle: inner.handle.clone().unwrap_or_default(),
        nostr_pub: inner
            .identity
            .as_ref()
            .map(|identity| hex::encode(identity.nostr.pub_bytes))
            .unwrap_or_default(),
        relays: inner.relay_urls.clone(),
        created_at: inner.created_at,
        avatar: inner.avatar.clone(),
        friends,
        blocked,
        groups,
        group_invites,
    }
}

/// Save the account, in one write: contacts, groups and invitations change
/// together (design §4.1). With no session, nothing is written.
pub fn persist_account(inner: &InnerState) -> Result<(), String> {
    inner
        .storage
        .write_account(&account_of(inner))
        .map_err(|e| e.to_string())
}
