//! Where the open session keeps its data (cifrado local CL-1b, design §12.3
//! and §13): the account, saved in one write, and the names in it wiped
//! from memory at a lock.

use crate::group::GroupRoster;
use crate::state::{FriendRecord, GroupInvite, InnerState};
use crate::store::session::AccountFile;
use zeroize::Zeroize;

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

/// Wipe the names in memory where it is cheap: this identity's, its
/// contacts' and its groups' (design §7.2). The maps are left empty.
pub fn zeroize_names(inner: &mut InnerState) {
    fn zeroize_roster(roster: &mut GroupRoster) {
        roster.name.zeroize();
        for member in &mut roster.members {
            member.handle.zeroize();
        }
    }
    if let Some(handle) = inner.handle.as_mut() {
        handle.zeroize();
    }
    for (mut name, mut friend) in inner.friends.drain() {
        name.zeroize();
        friend.handle.zeroize();
    }
    for (_, mut roster) in inner.groups.drain() {
        zeroize_roster(&mut roster);
    }
    for (_, mut invite) in inner.group_invites.drain() {
        zeroize_roster(&mut invite.roster);
        invite.from_handle.zeroize();
    }
    for mut key in inner.blocked.drain() {
        key.zeroize();
    }
}
