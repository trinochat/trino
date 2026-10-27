//! Solicitudes (uso responsable UR-4, `Uso responsable/diseno.md` §4): what
//! comes from someone who is not your contact waits here, apart from the
//! chats, until you accept it.
//!
//! - **Nothing here rings or downloads.** A request keeps the text, that a
//!   file came (its type and size; it is fetched only once accepted) and
//!   that they tried to call. No sound, no system notification, no read
//!   receipt, no answer of any kind: the UI gets `requests-changed` with the
//!   count, and nothing else.
//! - **Quotas per source** (R-11): links and codes, @name and contacts of a
//!   group, 20 each, so spam from one never pushes out another; one request
//!   per identity, with 20 items at most; 30 processed an hour. What does
//!   not fit is dropped and counted ("Llegaron más solicitudes…").
//! - **A request expires** 30 days after it came (U10).
//! - **Accept** makes the contact (or keeps the one a group made) and moves
//!   what came into its chat. **Delete** keeps the identity as deleted:
//!   what it sends in the next 30 days is dropped in silence, and Settings ›
//!   Privacidad › Solicitudes eliminadas can undo it (500 at most, the
//!   oldest out). **Block** is `block::BlockTarget::Request`, and drops the
//!   request with it.
//! - Kept in `requests.bin`, sealed as the rest of the store.
//!
//! Who feeds it: `receive` (or `receive_and_tell`) is the one way in. The
//! sources come with other tasks: a contact of a group who writes apart
//! (UR-3), the redemption of a link with approval (INV-18, UR-8), a Hello by
//! @name (INV-28) and, with P1, a code (P1-13). Their caller decides that it
//! is a request (an accepted contact's message goes to its chat) and what of
//! its keys the message proved.
//!
//! The account of someone of 16 or 17 (UR-10, U25) takes only the
//! redemptions of their own links: `close_to_strangers`. Whoever writes
//! otherwise sees what they see with an adult who never accepts.

use crate::block::bundle_fingerprint;
use crate::command_error::CommandError;
use crate::contacts::{check_local_handle, not_found};
use crate::events::EventSink;
use crate::group::FileRef;
use crate::identity::{verify_bundle_binding, PublicBundle};
use crate::state::{FriendRecord, HistItem, InnerState};
use crate::store::envelope::Slot;
use crate::store::session::Found;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use zeroize::{Zeroize, Zeroizing};

const DAY: i64 = 24 * 60 * 60;
/// Requests each source keeps at once (R-11).
pub const PER_SOURCE: usize = 20;
/// What one request keeps of one identity.
pub const ITEMS_PER_REQUEST: usize = 20;
/// What is processed in an hour, every source together.
pub const PER_HOUR: usize = 30;
/// A request nobody answered goes after this long (U10).
pub const EXPIRES_AFTER: i64 = 30 * DAY;
/// What a deleted identity sends is dropped for this long.
pub const DELETED_FOR: i64 = 30 * DAY;
/// The deleted identities kept; the oldest goes first.
pub const DELETED_MAX: usize = 500;
/// The longest text kept, as the composer counts it (`MAX_TEXT_LENGTH`).
pub const TEXT_MAX_CHARS: usize = 6_000;
/// The longest name kept, as a profile's.
const NAME_MAX_CHARS: usize = crate::profile::NAME_MAX_CHARS;

/// Where a request came from (design §4.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Via {
    /// A contact of the group `group` who wrote apart (UR-3). Their name is
    /// the one the admin wrote (R-10).
    Group { gid: String, group: String },
    /// Someone who used your friendship link `label` (INV-18).
    Link { label: String },
    /// Someone who found you by your @name (INV-28).
    Name,
    /// Someone who used your code `label` (P1-13).
    Code { label: String },
}

/// The quota a source counts against: links and codes share theirs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quota {
    Links,
    Name,
    Group,
}

impl Via {
    pub fn quota(&self) -> Quota {
        match self {
            Via::Link { .. } | Via::Code { .. } => Quota::Links,
            Via::Name => Quota::Name,
            Via::Group { .. } => Quota::Group,
        }
    }
}

/// One thing a request keeps.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    Text {
        text: String,
        at: i64,
    },
    /// Kept whole, so the chat can fetch it once accepted; the request
    /// shows only its type and size.
    File {
        file: FileRef,
        at: i64,
    },
    /// They tried to call: it did not ring (R-12).
    Call {
        video: bool,
        at: i64,
    },
}

/// Without the text or the file (TRN-CORE-05), as `HistItem`'s.
impl std::fmt::Debug for Item {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Item::Text { at, .. } => write!(f, "Text {{ at: {at} }}"),
            Item::File { file, at } => write!(f, "File {{ size: {}, at: {at} }}", file.size),
            Item::Call { video, at } => write!(f, "Call {{ video: {video}, at: {at} }}"),
        }
    }
}

impl Item {
    fn at(&self) -> i64 {
        match self {
            Item::Text { at, .. } | Item::File { at, .. } | Item::Call { at, .. } => *at,
        }
    }

    fn wipe(&mut self) {
        match self {
            Item::Text { text, .. } => text.zeroize(),
            Item::File { file, .. } => {
                file.url.zeroize();
                file.key.zeroize();
                file.name.zeroize();
                if let Some(thumb) = file.thumb.as_mut() {
                    thumb.zeroize();
                }
            }
            Item::Call { .. } => {}
        }
    }
}

/// One identity's request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub bundle: PublicBundle,
    /// As they call themselves; for a contact of a group, as the admin
    /// wrote it.
    pub name: String,
    pub via: Via,
    pub received_at: i64,
    pub last_at: i64,
    pub items: Vec<Item>,
    /// Items that did not fit.
    #[serde(default)]
    pub dropped: u32,
    /// Their Nostr key signed what came (R-02), as the caller said.
    #[serde(default)]
    pub nostr_proven: bool,
    /// Their DH key took part in an X3DH whose messages were read.
    #[serde(default)]
    pub dh_proven: bool,
}

impl Request {
    pub fn key(&self) -> &str {
        &self.bundle.ik_sign_pub
    }

    fn wipe(&mut self) {
        self.name.zeroize();
        for item in &mut self.items {
            item.wipe();
        }
    }
}

/// An identity whose request you deleted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub ik_sign: String,
    pub nostr_pub: String,
    pub label: String,
    pub fingerprint: String,
    pub deleted_at: i64,
}

/// Every request, and the identities deleted. What `requests.bin` keeps.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBook {
    #[serde(default)]
    requests: Vec<Request>,
    #[serde(default)]
    deleted: Vec<Deleted>,
    /// What did not fit, per quota, since one of its requests was last
    /// answered.
    #[serde(default)]
    overflow: BTreeMap<Quota, u32>,
    /// When the last ones were processed, for `PER_HOUR`. Memory only.
    #[serde(skip)]
    processed: VecDeque<i64>,
    /// `requests.bin` did not read at unlock: it is never written over
    /// this session.
    #[serde(skip)]
    not_loaded: bool,
    /// Only the redemptions of your own links (UR-10, U25). Set as the
    /// session opens by whoever knows the account's age.
    #[serde(skip)]
    closed_to_strangers: bool,
}

/// What came, as the caller of `receive` read it.
#[derive(Clone, Debug)]
pub struct Incoming {
    pub bundle: PublicBundle,
    pub name: String,
    pub via: Via,
    pub item: Item,
    pub nostr_proven: bool,
    pub dh_proven: bool,
}

/// What `receive` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Received {
    /// A new request.
    New,
    /// One more item of a request there was.
    Added,
    /// Nothing; the reason is only for the log.
    Dropped(&'static str),
}

/// A request as Solicitudes shows it: never a file's address or key, nor a
/// photo.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RequestView {
    /// Their identity key: what the actions take.
    pub key: String,
    pub name: String,
    /// The name is the admin's (R-10): it shows as "~name".
    pub by_admin: bool,
    pub fingerprint: String,
    pub via: Via,
    pub received_at: i64,
    pub last_at: i64,
    pub items: Vec<ItemView>,
    pub dropped: u32,
    /// The contact whose name theirs resembles: "Se parece a {contact}".
    pub looks_like: Option<String>,
}

/// One item as Solicitudes shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemView {
    Text { text: String, at: i64 },
    File { mime: String, size: u64, at: i64 },
    Call { video: bool, at: i64 },
}

/// The list, and how many did not fit.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RequestsView {
    pub requests: Vec<RequestView>,
    pub overflow: u32,
    /// The account is of 16 or 17 (UR-10): only its links' redemptions
    /// come, and the list says so (PropMenoresPC card 7).
    pub only_links: bool,
}

/// One row of Solicitudes eliminadas.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeletedView {
    pub key: String,
    pub label: String,
    pub fingerprint: String,
    pub deleted_at: i64,
}

/// What `requests-changed` says: the count, never who or what.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RequestsChanged {
    pub count: usize,
}

impl RequestBook {
    pub fn len(&self) -> usize {
        self.requests.len()
    }

    pub fn is_empty(&self) -> bool {
        self.requests.is_empty()
    }

    pub fn get(&self, ik_sign: &str) -> Option<&Request> {
        self.requests
            .iter()
            .find(|request| request.key() == ik_sign)
    }

    fn position(&self, ik_sign: &str) -> Result<usize, CommandError> {
        self.requests
            .iter()
            .position(|request| request.key() == ik_sign)
            .ok_or_else(|| not_found("no such request"))
    }

    /// Whether `ik_sign` was deleted less than `DELETED_FOR` before `now`.
    fn is_deleted(&self, ik_sign: &str, now: i64) -> bool {
        self.deleted
            .iter()
            .any(|deleted| deleted.ik_sign == ik_sign && now - deleted.deleted_at < DELETED_FOR)
    }

    /// Take out the request at `at`; its quota's count of what did not fit
    /// goes with it, since there is room now.
    fn take(&mut self, at: usize) -> Request {
        let request = self.requests.remove(at);
        self.overflow.remove(&request.via.quota());
        request
    }

    /// Whether `PER_HOUR` were processed in the hour before `now`; if not,
    /// this one counts.
    fn busy(&mut self, now: i64) -> bool {
        while self.processed.front().is_some_and(|&at| now - at >= HOUR) {
            self.processed.pop_front();
        }
        if self.processed.len() >= PER_HOUR {
            return true;
        }
        self.processed.push_back(now);
        false
    }

    /// Whether a request of yours you deleted had the Nostr key `nostr`:
    /// its events give no "intentó escribirte" either.
    pub fn deleted_nostr(&self, nostr: &str) -> bool {
        self.deleted
            .iter()
            .any(|deleted| deleted.nostr_pub == nostr)
    }

    /// Take out the request and the deletion of `ik_sign`, as a block
    /// does. Whether anything went.
    pub fn forget_identity(&mut self, ik_sign: &str) -> bool {
        let before = self.requests.len() + self.deleted.len();
        if let Some(at) = self.requests.iter().position(|r| r.key() == ik_sign) {
            self.take(at).wipe();
        }
        self.deleted.retain(|deleted| deleted.ik_sign != ik_sign);
        self.requests.len() + self.deleted.len() != before
    }

    /// Take out what expired by `now`. Whether anything went.
    pub fn prune(&mut self, now: i64) -> bool {
        let before = self.requests.len() + self.deleted.len();
        let (kept, gone): (Vec<Request>, Vec<Request>) = std::mem::take(&mut self.requests)
            .into_iter()
            .partition(|request| now - request.received_at < EXPIRES_AFTER);
        self.requests = kept;
        for mut request in gone {
            self.overflow.remove(&request.via.quota());
            request.wipe();
        }
        self.deleted
            .retain(|deleted| now - deleted.deleted_at < DELETED_FOR);
        self.requests.len() + self.deleted.len() != before
    }

    /// The account is of 16 or 17 (UR-10, U25, U23): from now on only the
    /// redemptions of its own links, and the other requests go. Whether
    /// any went.
    pub fn close_to_strangers(&mut self) -> bool {
        self.closed_to_strangers = true;
        let before = self.requests.len();
        let (kept, gone): (Vec<Request>, Vec<Request>) = std::mem::take(&mut self.requests)
            .into_iter()
            .partition(|request| matches!(request.via, Via::Link { .. }));
        self.requests = kept;
        for mut request in gone {
            request.wipe();
        }
        self.overflow.retain(|quota, _| *quota == Quota::Links);
        self.requests.len() != before
    }

    pub fn closed_to_strangers(&self) -> bool {
        self.closed_to_strangers
    }

    /// The account is of 18 or more again (UR-10, U17): requests of every
    /// source reach it from now on. Nothing dropped comes back.
    pub fn open_to_strangers(&mut self) {
        self.closed_to_strangers = false;
    }

    /// Empty it, wiping names and texts, as a lock does.
    pub fn forget(&mut self) {
        for request in &mut self.requests {
            request.wipe();
        }
        for deleted in &mut self.deleted {
            deleted.label.zeroize();
        }
        *self = RequestBook::default();
    }
}

const HOUR: i64 = 60 * 60;

/// Take `incoming` as a request, or one more item of one there is.
///
/// In this order, each a silent drop: keys their identity key did not sign;
/// your own; someone blocked (P1 §6.3); an identity deleted in the last 30
/// days; anything but a link's on an account closed to strangers; a key
/// another contact holds (P1 R-14). Then the hour's limit, the request of
/// that identity (20 items) and the quota of its source.
pub fn receive(inner: &mut InnerState, incoming: Incoming, now: i64) -> Received {
    inner.requests.prune(now);
    let bundle = &incoming.bundle;
    if !verify_bundle_binding(bundle) {
        return Received::Dropped("keys not bound to their identity");
    }
    let mine = inner
        .identity
        .as_ref()
        .map(|identity| hex::encode(identity.ik_sign.pub_bytes));
    if mine.as_deref() == Some(bundle.ik_sign_pub.as_str()) {
        return Received::Dropped("my own identity");
    }
    if inner.blocked.blocks_bundle(bundle) {
        return Received::Dropped("blocked");
    }
    if inner.requests.is_deleted(&bundle.ik_sign_pub, now) {
        return Received::Dropped("deleted in the last 30 days");
    }
    if inner.requests.closed_to_strangers && !matches!(incoming.via, Via::Link { .. }) {
        return Received::Dropped("only the redemptions of my links");
    }
    if holds_a_contacts_key(inner, bundle) {
        return Received::Dropped("a key of theirs is another contact's");
    }
    let quota = incoming.via.quota();
    let book = &mut inner.requests;
    let existing = book
        .requests
        .iter()
        .position(|request| request.key() == incoming.bundle.ik_sign_pub);
    if book.busy(now) {
        match existing {
            Some(at) => book.requests[at].dropped += 1,
            None => *book.overflow.entry(quota).or_default() += 1,
        }
        return Received::Dropped("busy: the hour's requests were processed");
    }
    let item = bounded(incoming.item);
    if let Some(at) = existing {
        let request = &mut book.requests[at];
        if request.items.len() >= ITEMS_PER_REQUEST {
            request.dropped += 1;
            return Received::Dropped("their request is full");
        }
        request.last_at = request.last_at.max(item.at());
        request.items.push(item);
        // What proves their keys only grows.
        request.nostr_proven |= incoming.nostr_proven;
        request.dh_proven |= incoming.dh_proven;
        return Received::Added;
    }
    let taken = book
        .requests
        .iter()
        .filter(|request| request.via.quota() == quota)
        .count();
    if taken >= PER_SOURCE {
        *book.overflow.entry(quota).or_default() += 1;
        return Received::Dropped("the quota of its source is full");
    }
    book.requests.push(Request {
        name: crate::profile::shown_name(&incoming.name, NAME_MAX_CHARS, ""),
        via: incoming.via,
        received_at: now,
        last_at: item.at(),
        items: vec![item],
        dropped: 0,
        nostr_proven: incoming.nostr_proven,
        dh_proven: incoming.dh_proven,
        bundle: incoming.bundle,
    });
    Received::New
}

/// A text cut to `TEXT_MAX_CHARS`; anything else as it is.
fn bounded(item: Item) -> Item {
    match item {
        Item::Text { text, at } if text.chars().count() > TEXT_MAX_CHARS => Item::Text {
            text: text.chars().take(TEXT_MAX_CHARS).collect(),
            at,
        },
        item => item,
    }
}

/// Whether the DH or Nostr key of `bundle` is a contact's of another
/// identity: then it is no request (P1 R-14), and accepting it would make
/// two contacts share a key.
fn holds_a_contacts_key(inner: &InnerState, bundle: &PublicBundle) -> bool {
    inner.friends.values().any(|friend| {
        let theirs = &friend.bundle;
        theirs.ik_sign_pub != bundle.ik_sign_pub
            && (theirs.ik_dh_pub == bundle.ik_dh_pub || theirs.nostr_pub == bundle.nostr_pub)
    })
}

/// `receive`, then save and tell the UI the count if anything changed.
pub fn receive_and_tell(
    events: &dyn EventSink,
    inner: &mut InnerState,
    incoming: Incoming,
    now: i64,
) -> Received {
    let received = receive(inner, incoming, now);
    if let Received::Dropped(why) = received {
        crate::session::dbg_log(why);
        return received;
    }
    save(inner);
    tell(events, inner);
    received
}

/// `requests-changed`, with the count only.
pub fn tell(events: &dyn EventSink, inner: &InnerState) {
    events.emit(
        "requests-changed",
        &RequestsChanged {
            count: inner.requests.len(),
        },
    );
}

/// Accept the request of `key`: the contact it makes (or the one a group
/// made), with what came in its chat. `key_clash` when a key of theirs is
/// another contact's.
///
/// The call they tried does not move: it never rang, and the request said
/// so. Nothing is sent to them here: a request that came with a Hello
/// answers with yours (INV, P1 §4.1), from that task.
pub fn accept(inner: &mut InnerState, key: &str, now: i64) -> Result<String, CommandError> {
    inner.requests.prune(now);
    let at = inner.requests.position(key)?;
    let known = inner
        .friends
        .values()
        .find(|friend| friend.bundle.ik_sign_pub == key)
        .map(|friend| friend.handle.clone());
    let handle = match known {
        // A contact of a group (UR-3): accepted from now on.
        Some(handle) => {
            if let Some(friend) = inner.friends.get_mut(&handle) {
                friend.accepted_at.get_or_insert(now);
            }
            handle
        }
        None => {
            let request = &inner.requests.requests[at];
            if holds_a_contacts_key(inner, &request.bundle) {
                return Err(crate::block::key_clash());
            }
            let handle = free_handle(inner, &request.name, key);
            let bundle = request.bundle.clone();
            inner.friends.insert(
                handle.clone(),
                FriendRecord {
                    handle: handle.clone(),
                    bundle,
                    added_at: now,
                    avatar: None,
                    previous_fingerprint: None,
                    key_changed_at: None,
                    via_group: None,
                    accepted_at: Some(now),
                },
            );
            handle
        }
    };
    let request = inner.requests.take(at);
    let chat = inner.history.entry(handle.clone()).or_default();
    for item in request.items {
        let (text, file, ts) = match item {
            Item::Text { text, at } => (Some(text), None, at),
            Item::File { file, at } => (None, Some(file), at),
            Item::Call { .. } => continue,
        };
        chat.push(HistItem {
            side: "them".into(),
            from: None,
            text,
            file,
            call: None,
            ts,
        });
    }
    chat.sort_by_key(|item| item.ts);
    Ok(handle)
}

/// The name a new contact takes: theirs if it can name a contact and is
/// free, as a roster's member gets it (`merge_group_members`), else with
/// the start of their key.
fn free_handle(inner: &InnerState, name: &str, key: &str) -> String {
    let name = match check_local_handle(name) {
        Ok(()) => name,
        Err(_) => "",
    };
    if !name.is_empty() && !inner.friends.contains_key(name) {
        return name.to_string();
    }
    [4, 8, 16, 64]
        .into_iter()
        .map(|len| format!("{name}-{}", &key[..len.min(key.len())]))
        .find(|handle| !inner.friends.contains_key(handle))
        .unwrap_or_else(|| key.to_string())
}

/// Delete the request of `key`: what it sends in the next 30 days is
/// dropped in silence.
pub fn delete(inner: &mut InnerState, key: &str, now: i64) -> Result<(), CommandError> {
    let book = &mut inner.requests;
    let at = book.position(key)?;
    let mut request = book.take(at);
    book.deleted.retain(|deleted| deleted.ik_sign != key);
    book.deleted.push(Deleted {
        ik_sign: key.to_string(),
        nostr_pub: request.bundle.nostr_pub.clone(),
        label: request.name.clone(),
        fingerprint: bundle_fingerprint(&request.bundle),
        deleted_at: now,
    });
    if book.deleted.len() > DELETED_MAX {
        let oldest = book
            .deleted
            .iter()
            .enumerate()
            .min_by_key(|(_, deleted)| deleted.deleted_at)
            .map(|(at, _)| at)
            .expect("there is one");
        book.deleted.remove(oldest).label.zeroize();
    }
    request.wipe();
    Ok(())
}

/// Let the deleted `key` send requests again.
pub fn undo_delete(inner: &mut InnerState, key: &str) -> Result<(), CommandError> {
    let deleted = &mut inner.requests.deleted;
    let at = deleted
        .iter()
        .position(|deleted| deleted.ik_sign == key)
        .ok_or_else(|| not_found("not deleted"))?;
    deleted.remove(at).label.zeroize();
    Ok(())
}

/// Solicitudes, the latest first.
pub fn list(inner: &InnerState, now: i64) -> RequestsView {
    let mut requests: Vec<RequestView> = inner
        .requests
        .requests
        .iter()
        .filter(|request| now - request.received_at < EXPIRES_AFTER)
        .map(|request| view(inner, request))
        .collect();
    requests.sort_by(|a, b| b.last_at.cmp(&a.last_at).then(a.key.cmp(&b.key)));
    RequestsView {
        requests,
        overflow: inner.requests.overflow.values().sum(),
        only_links: inner.requests.closed_to_strangers,
    }
}

fn view(inner: &InnerState, request: &Request) -> RequestView {
    let items = request
        .items
        .iter()
        .map(|item| match item {
            Item::Text { text, at } => ItemView::Text {
                text: text.clone(),
                at: *at,
            },
            Item::File { file, at } => ItemView::File {
                mime: file.mime.clone(),
                size: file.size,
                at: *at,
            },
            Item::Call { video, at } => ItemView::Call {
                video: *video,
                at: *at,
            },
        })
        .collect();
    let looks_like = inner
        .friends
        .values()
        .filter(|friend| friend.bundle.ik_sign_pub != request.key())
        .map(|friend| friend.handle.as_str())
        .filter(|handle| looks_like(&request.name, handle))
        .min()
        .map(str::to_string);
    RequestView {
        key: request.key().to_string(),
        name: request.name.clone(),
        by_admin: matches!(request.via, Via::Group { .. }),
        fingerprint: bundle_fingerprint(&request.bundle),
        via: request.via.clone(),
        received_at: request.received_at,
        last_at: request.last_at,
        items,
        dropped: request.dropped,
        looks_like,
    }
}

/// Solicitudes eliminadas, the latest first.
pub fn list_deleted(inner: &InnerState, now: i64) -> Vec<DeletedView> {
    let mut shown: Vec<DeletedView> = inner
        .requests
        .deleted
        .iter()
        .filter(|deleted| now - deleted.deleted_at < DELETED_FOR)
        .map(|deleted| DeletedView {
            key: deleted.ik_sign.clone(),
            label: deleted.label.clone(),
            fingerprint: deleted.fingerprint.clone(),
            deleted_at: deleted.deleted_at,
        })
        .collect();
    shown.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(a.key.cmp(&b.key)));
    shown
}

/// Whether two names could be taken for each other: the same, but for
/// case, accents, a few digits that pass for letters and the end of a
/// longer name ("ana" and "Ana Torres"), or one letter apart.
pub fn looks_like(a: &str, b: &str) -> bool {
    let (a, b) = (folded(a), folded(b));
    if a.chars().count() < 3 || b.chars().count() < 3 {
        return false;
    }
    let first = |name: &str| name.split(' ').next().unwrap_or_default().to_string();
    a == b || first(&a) == first(&b) || (a.chars().count() >= 4 && one_apart(&a, &b))
}

/// Lower case, without accents, with the digits that pass for letters as
/// those letters, and only letters and single spaces.
fn folded(name: &str) -> String {
    let mapped: String = name
        .trim_start_matches('~')
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | '4' | '@' => 'a',
            'é' | 'è' | 'ê' | 'ë' | '3' => 'e',
            'í' | 'ì' | 'î' | 'ï' | '1' | '!' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | '0' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            '5' | '$' => 's',
            '7' => 't',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether `a` becomes `b` by one letter added, taken out or changed, and
/// they start alike (so "bob" and "rob" are two names, not one).
fn one_apart(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.first() != b.first() || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (short, long) = if a.len() <= b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let same = short
        .iter()
        .zip(long.iter())
        .take_while(|(x, y)| x == y)
        .count();
    if same == short.len() {
        return true;
    }
    if short.len() == long.len() {
        short[same + 1..] == long[same + 1..]
    } else {
        short[same..] == long[same + 1..]
    }
}

/// Load what unlocking found in `requests.bin` into the session.
///
/// One that waits, could not be read now, or opens but does not read stays
/// as it is: this session never writes it (`not_loaded`), and the next
/// unlock reads it again. What comes meanwhile lasts until the lock.
pub fn load(inner: &mut InnerState, found: Found, now: i64) {
    let loaded = match found {
        Found::Ready(json) => {
            let book = serde_json::from_slice::<RequestBook>(&json).ok();
            if book.is_none() {
                inner.storage.hold(&Slot::Requests);
            }
            book
        }
        Found::Absent => Some(RequestBook::default()),
        Found::Held => None,
    };
    let closed = inner.requests.closed_to_strangers;
    inner.requests.forget();
    inner.requests = loaded.unwrap_or_else(|| RequestBook {
        not_loaded: true,
        ..RequestBook::default()
    });
    if closed {
        inner.requests.close_to_strangers();
    }
    if inner.requests.prune(now) {
        save(inner);
    }
}

/// Save the requests, sealed. Never over a `requests.bin` that did not read.
pub fn try_save(inner: &InnerState) -> std::io::Result<()> {
    if inner.requests.not_loaded {
        return Err(std::io::Error::other(
            "requests.bin could not be read at unlock: it stays as it is",
        ));
    }
    let json = Zeroizing::new(serde_json::to_vec(&inner.requests).map_err(std::io::Error::other)?);
    inner.storage.write_requests(&json)
}

/// `try_save`, where a failure is only logged.
pub fn save(inner: &InnerState) {
    if try_save(inner).is_err() {
        crate::session::dbg_log("the requests could not be saved");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::identity::{create_identity, public_bundle_for, Identity};
    use crate::session::tests::{friend, ik, NOW};

    const HOUR: i64 = 60 * 60;

    fn me() -> InnerState {
        InnerState {
            identity: Some(create_identity()),
            handle: Some("me".into()),
            ..InnerState::default()
        }
    }

    fn text(words: &str, at: i64) -> Item {
        Item::Text {
            text: words.into(),
            at,
        }
    }

    fn from(id: &Identity, name: &str, via: Via, item: Item) -> Incoming {
        Incoming {
            bundle: public_bundle_for(id),
            name: name.into(),
            via,
            item,
            nostr_proven: true,
            dh_proven: true,
        }
    }

    fn by_name(id: &Identity, words: &str, at: i64) -> Incoming {
        from(id, "ana", Via::Name, text(words, at))
    }

    fn link(label: &str) -> Via {
        Via::Link {
            label: label.into(),
        }
    }

    fn group() -> Via {
        Via::Group {
            gid: "g1".into(),
            group: "Familia".into(),
        }
    }

    fn photo(at: i64) -> Item {
        Item::File {
            file: FileRef {
                url: "https://blossom.example/secret-url".into(),
                key: "ab".repeat(32),
                sha256: "0".repeat(64),
                mime: "image/jpeg".into(),
                name: "torta.jpg".into(),
                size: 1_200_000,
                thumb: Some("data:image/jpeg;base64,THUMBNAIL".into()),
            },
            at,
        }
    }

    // ---- Design test 13: apart from the chats, and silent ----

    #[test]
    fn ur4_13_a_request_waits_apart_and_tells_only_the_count() {
        let mut inner = me();
        let ana = create_identity();
        let sink = crate::events::RecordingSink::new();

        let got = receive_and_tell(&*sink, &mut inner, by_name(&ana, "hola, soy ana", NOW), NOW);

        assert_eq!(got, Received::New);
        assert_eq!(inner.requests.len(), 1);
        assert!(inner.history.is_empty(), "nothing in the chats");
        assert!(inner.friends.is_empty(), "no contact");
        assert_eq!(
            sink.events(),
            [("requests-changed".to_string(), r#"{"count":1}"#.to_string())],
            "no message event, no name, no text"
        );
        // One more from her is one more item of the same request.
        let more = receive_and_tell(
            &*sink,
            &mut inner,
            by_name(&ana, "¿estás?", NOW + 5),
            NOW + 5,
        );
        assert_eq!(more, Received::Added);
        assert_eq!(inner.requests.len(), 1);
        assert_eq!(inner.requests.get(&ik(&ana)).unwrap().items.len(), 2);
        assert_eq!(inner.requests.get(&ik(&ana)).unwrap().last_at, NOW + 5);
        // What is dropped says nothing.
        let mine = inner.identity.clone().unwrap();
        let dropped = receive_and_tell(&*sink, &mut inner, by_name(&mine, "yo", NOW + 6), NOW + 6);
        assert!(matches!(dropped, Received::Dropped(_)), "{dropped:?}");
        assert_eq!(sink.events().len(), 2);
    }

    #[test]
    fn ur4_what_never_becomes_a_request() {
        let mut inner = me();
        let (eve, carol, mallory) = (create_identity(), create_identity(), create_identity());
        inner
            .friends
            .insert("carol".into(), friend(&carol, "carol"));
        // Eve is blocked.
        inner.friends.insert("eve".into(), friend(&eve, "eve"));
        crate::block::block(
            &mut inner,
            &crate::block::BlockTarget::Contact("eve".into()),
            crate::block::BlockOrigin::Contact,
            NOW,
        )
        .unwrap();
        inner.friends.remove("eve");
        // Mallory's bundle carries carol's Nostr key, validly bound.
        let mut shadow = mallory.clone();
        shadow.nostr = carol.nostr.clone();
        // A bundle whose keys its identity key did not sign.
        let mut unbound = public_bundle_for(&create_identity());
        unbound.nostr_pub = hex::encode(create_identity().nostr.pub_bytes);
        let mine = inner.identity.clone().unwrap();

        for (incoming, why) in [
            (by_name(&eve, "hola", NOW), "blocked"),
            (by_name(&mine, "hola", NOW), "mine"),
            (by_name(&shadow, "hola", NOW), "a contact's key"),
            (
                Incoming {
                    bundle: unbound,
                    ..by_name(&create_identity(), "hola", NOW)
                },
                "unbound",
            ),
        ] {
            let got = receive(&mut inner, incoming, NOW);
            assert!(matches!(got, Received::Dropped(_)), "{why}: {got:?}");
        }
        assert!(inner.requests.is_empty());
    }

    // ---- Design test 17: accept and delete ----

    #[test]
    fn ur4_17_accepting_makes_the_contact_with_what_came_in_its_chat() {
        let mut inner = me();
        let ana = create_identity();
        receive(&mut inner, by_name(&ana, "hola, soy ana", NOW), NOW);
        receive(
            &mut inner,
            from(&ana, "ana", Via::Name, photo(NOW + 1)),
            NOW + 1,
        );
        receive(
            &mut inner,
            from(
                &ana,
                "ana",
                Via::Name,
                Item::Call {
                    video: false,
                    at: NOW + 2,
                },
            ),
            NOW + 2,
        );

        let handle = accept(&mut inner, &ik(&ana), NOW + 9).unwrap();

        assert_eq!(handle, "ana");
        let contact = &inner.friends["ana"];
        assert_eq!(contact.bundle.ik_sign_pub, ik(&ana));
        assert_eq!(contact.via_group, None);
        assert_eq!(contact.added_at, NOW + 9);
        let chat = &inner.history["ana"];
        assert_eq!(
            chat.len(),
            2,
            "the text and the file; the call did not ring"
        );
        assert_eq!(chat[0].text.as_deref(), Some("hola, soy ana"));
        assert_eq!(chat[0].side, "them");
        assert_eq!(chat[0].ts, NOW);
        assert_eq!(chat[1].file.as_ref().unwrap().name, "torta.jpg");
        assert!(inner.requests.is_empty());
        assert_eq!(
            accept(&mut inner, &ik(&ana), NOW).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn ur4_17_accepting_takes_a_free_name_and_keeps_a_contact_of_a_group() {
        let mut inner = me();
        let (ana, ana2, mara) = (create_identity(), create_identity(), create_identity());
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        // Another "ana", by her @name.
        receive(&mut inner, by_name(&ana2, "hola", NOW), NOW);
        // Mara, a contact the group made, wrote apart (UR-3).
        let mut maras = friend(&mara, "mara");
        maras.via_group = Some("g1".into());
        maras.accepted_at = None;
        inner.friends.insert("mara".into(), maras);
        receive(
            &mut inner,
            from(&mara, "mara", group(), text("¿me pasas la dirección?", NOW)),
            NOW,
        );

        let other = accept(&mut inner, &ik(&ana2), NOW).unwrap();
        let same = accept(&mut inner, &ik(&mara), NOW).unwrap();

        assert_eq!(other, format!("ana-{}", &ik(&ana2)[..4]));
        assert_eq!(inner.friends[&other].bundle.ik_sign_pub, ik(&ana2));
        assert_eq!(same, "mara");
        assert_eq!(inner.friends["mara"].accepted_at, Some(NOW), "accepted now");
        assert_eq!(inner.friends.len(), 3);
        assert_eq!(inner.history["mara"].len(), 1);
    }

    #[test]
    fn ur4_17_deleting_drops_what_they_send_for_30_days_and_can_be_undone() {
        let mut inner = me();
        let (ana, bob) = (create_identity(), create_identity());
        receive(&mut inner, by_name(&ana, "hola", NOW), NOW);
        receive(&mut inner, by_name(&bob, "hola", NOW), NOW);

        delete(&mut inner, &ik(&ana), NOW + 10).unwrap();

        assert_eq!(inner.requests.len(), 1);
        let deleted = list_deleted(&inner, NOW + 10);
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].key, ik(&ana));
        assert_eq!(deleted[0].label, "ana");
        assert!(inner
            .requests
            .deleted_nostr(&hex::encode(ana.nostr.pub_bytes)));
        // Undone at once.
        delete(&mut inner, &ik(&bob), NOW + 20).unwrap();
        undo_delete(&mut inner, &ik(&bob)).unwrap();
        assert_eq!(
            receive(&mut inner, by_name(&bob, "hola", NOW + 30), NOW + 30),
            Received::New
        );
        assert_eq!(
            undo_delete(&mut inner, &ik(&bob)).unwrap_err().code,
            ErrorCode::NotFound
        );
        let later = NOW + 10 + DELETED_FOR - 1;
        assert!(matches!(
            receive(&mut inner, by_name(&ana, "otra vez", later), later),
            Received::Dropped(_)
        ));
        // After 30 days she can write again, and the deletion is gone.
        let after = NOW + 10 + DELETED_FOR;
        assert_eq!(
            receive(&mut inner, by_name(&ana, "hola", after), after),
            Received::New
        );
        assert!(list_deleted(&inner, after).is_empty());
        assert_eq!(
            delete(&mut inner, &ik(&create_identity()), NOW)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    // ---- Design test 18: quotas (R-11) ----

    #[test]
    fn ur4_18_a_full_source_never_pushes_out_another() {
        let mut inner = me();
        for n in 0..PER_SOURCE as i64 + 1 {
            receive(
                &mut inner,
                by_name(&create_identity(), "hola", NOW + n),
                NOW + n,
            );
        }
        assert_eq!(inner.requests.len(), PER_SOURCE);
        assert_eq!(list(&inner, NOW + 30).overflow, 1);

        let mara = create_identity();
        let got = receive(
            &mut inner,
            from(&mara, "mara", link("Para Mara"), text("soy mara", NOW + 40)),
            NOW + 40,
        );
        let mine = receive(
            &mut inner,
            from(
                &create_identity(),
                "juan",
                Via::Code {
                    label: "Trabajo".into(),
                },
                text("hola", NOW + 41),
            ),
            NOW + 41,
        );

        assert_eq!((got, mine), (Received::New, Received::New));
        assert_eq!(inner.requests.len(), PER_SOURCE + 2);
        // Answering one of the full source clears its count.
        let first = list(&inner, NOW + 50)
            .requests
            .into_iter()
            .find(|r| r.via == Via::Name)
            .unwrap();
        delete(&mut inner, &first.key, NOW + 50).unwrap();
        assert_eq!(list(&inner, NOW + 50).overflow, 0);
    }

    #[test]
    fn ur4_18_one_request_per_identity_with_20_items_at_most() {
        let mut inner = me();
        let ana = create_identity();
        for n in 0..ITEMS_PER_REQUEST as i64 {
            receive(
                &mut inner,
                by_name(&ana, &format!("mensaje {n}"), NOW + n),
                NOW + n,
            );
        }
        let over = NOW + 99;
        let got = receive(&mut inner, by_name(&ana, "uno más", over), over);

        assert!(matches!(got, Received::Dropped(_)), "{got:?}");
        let request = inner.requests.get(&ik(&ana)).unwrap();
        assert_eq!(request.items.len(), ITEMS_PER_REQUEST);
        assert_eq!(request.dropped, 1);
        assert_eq!(request.items[0], text("mensaje 0", NOW), "the first stay");
    }

    #[test]
    fn ur4_18_thirty_an_hour() {
        let mut inner = me();
        let sources = [Via::Name, link("x"), group()];
        for n in 0..PER_HOUR {
            let via = sources[n % 3].clone();
            let at = NOW + n as i64;
            let got = receive(
                &mut inner,
                from(&create_identity(), "x", via, text("hola", at)),
                at,
            );
            assert_eq!(got, Received::New, "{n}");
        }
        let at = NOW + HOUR - 1;
        let got = receive(
            &mut inner,
            from(&create_identity(), "x", link("x"), text("hola", at)),
            at,
        );
        assert!(matches!(got, Received::Dropped(_)), "{got:?}");
        assert_eq!(list(&inner, at).overflow, 1);
        // An hour after the first, there is room again.
        let at = NOW + HOUR;
        let got = receive(
            &mut inner,
            from(&create_identity(), "x", link("x"), text("hola", at)),
            at,
        );
        assert_eq!(got, Received::New);
    }

    #[test]
    fn ur4_18_the_deleted_list_keeps_500_and_the_oldest_goes() {
        let mut inner = me();
        let mut first = String::new();
        for n in 0..=DELETED_MAX as i64 {
            let at = NOW + n * 120;
            let id = create_identity();
            receive(&mut inner, by_name(&id, "spam", at), at);
            delete(&mut inner, &ik(&id), at).unwrap();
            if n == 0 {
                first = ik(&id);
            }
        }
        let now = NOW + DELETED_MAX as i64 * 120;
        let deleted = list_deleted(&inner, now);
        assert_eq!(deleted.len(), DELETED_MAX);
        assert!(deleted.iter().all(|d| d.key != first), "the oldest went");
        assert!(
            deleted[0].deleted_at >= deleted[DELETED_MAX - 1].deleted_at,
            "latest first"
        );
    }

    // ---- Design test 19: expiry (U10) ----

    #[test]
    fn ur4_19_a_request_expires_30_days_after_it_came() {
        let mut inner = me();
        let ana = create_identity();
        receive(&mut inner, by_name(&ana, "hola", NOW), NOW);
        // Writing again does not keep it alive.
        receive(
            &mut inner,
            by_name(&ana, "¿hola?", NOW + 20 * DAY),
            NOW + 20 * DAY,
        );

        assert_eq!(list(&inner, NOW + EXPIRES_AFTER - 1).requests.len(), 1);
        assert!(list(&inner, NOW + EXPIRES_AFTER).requests.is_empty());
        assert!(!inner.requests.prune(NOW + EXPIRES_AFTER - 1));
        assert!(inner.requests.prune(NOW + EXPIRES_AFTER));
        assert!(inner.requests.is_empty());
        // What she sends then is a new request.
        let at = NOW + EXPIRES_AFTER + 1;
        assert_eq!(
            receive(&mut inner, by_name(&ana, "hola", at), at),
            Received::New
        );
    }

    // ---- What Solicitudes shows ----

    #[test]
    fn ur4_the_view_never_carries_a_files_address_key_or_photo() {
        let mut inner = me();
        let ana = create_identity();
        receive(&mut inner, from(&ana, "ana", Via::Name, photo(NOW)), NOW);

        let shown = list(&inner, NOW);
        let json = serde_json::to_string(&shown).unwrap();

        assert_eq!(
            shown.requests[0].items,
            [ItemView::File {
                mime: "image/jpeg".into(),
                size: 1_200_000,
                at: NOW
            }]
        );
        for secret in ["secret-url", &"ab".repeat(32), "THUMBNAIL", "torta.jpg"] {
            assert!(!json.contains(secret), "{secret} in {json}");
        }
    }

    #[test]
    fn ur4_the_view_says_where_it_came_from_and_whom_it_resembles() {
        let mut inner = me();
        let (ana_torres, ana, mara) = (create_identity(), create_identity(), create_identity());
        inner
            .friends
            .insert("Ana Torres".into(), friend(&ana_torres, "Ana Torres"));
        receive(&mut inner, by_name(&ana, "hola", NOW), NOW);
        receive(
            &mut inner,
            from(&mara, "mara", group(), text("hola", NOW + 1)),
            NOW + 1,
        );

        let shown = list(&inner, NOW + 2).requests;

        assert_eq!(shown[0].name, "mara", "latest first");
        assert!(shown[0].by_admin);
        assert_eq!(shown[0].via, group());
        assert_eq!(shown[0].looks_like, None);
        assert_eq!(shown[1].name, "ana");
        assert!(!shown[1].by_admin);
        assert_eq!(shown[1].looks_like.as_deref(), Some("Ana Torres"));
        assert_eq!(
            shown[1].fingerprint,
            bundle_fingerprint(&public_bundle_for(&ana))
        );
        assert_eq!(
            serde_json::to_value(&shown[0].via).unwrap(),
            serde_json::json!({ "kind": "group", "gid": "g1", "group": "Familia" })
        );
    }

    /// The shape src/lib/api.ts reads (`RequestsView`).
    #[test]
    fn ur4_the_list_reaches_the_frontend_as_api_ts_reads_it() {
        let mut inner = me();
        let ana = create_identity();
        receive(&mut inner, by_name(&ana, "hola", NOW), NOW);
        let call = Item::Call {
            video: true,
            at: NOW + 1,
        };
        receive(&mut inner, from(&ana, "ana", Via::Name, call), NOW + 1);

        let json = serde_json::to_value(list(&inner, NOW + 2)).unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "requests": [{
                    "key": ik(&ana),
                    "name": "ana",
                    "by_admin": false,
                    "fingerprint": bundle_fingerprint(&public_bundle_for(&ana)),
                    "via": { "kind": "name" },
                    "received_at": NOW,
                    "last_at": NOW + 1,
                    "items": [
                        { "kind": "text", "text": "hola", "at": NOW },
                        { "kind": "call", "video": true, "at": NOW + 1 },
                    ],
                    "dropped": 0,
                    "looks_like": null,
                }],
                "overflow": 0,
                "only_links": false,
            })
        );
        delete(&mut inner, &ik(&ana), NOW + 3).unwrap();
        let json = serde_json::to_value(list_deleted(&inner, NOW + 3)).unwrap();
        assert_eq!(
            json,
            serde_json::json!([{
                "key": ik(&ana),
                "label": "ana",
                "fingerprint": bundle_fingerprint(&public_bundle_for(&ana)),
                "deleted_at": NOW + 3,
            }])
        );
    }

    #[test]
    fn ur4_names_that_resemble() {
        for (a, b) in [
            ("ana", "Ana Torres"),
            ("Ána", "ana"),
            ("an4", "ana"),
            ("mamá", "Mama"),
            ("carlos", "carlo"),
        ] {
            assert!(looks_like(a, b), "{a} ~ {b}");
        }
        for (a, b) in [
            ("ana", "juan"),
            ("al", "alberto"),
            ("", "ana"),
            ("bob", "rob"),
        ] {
            assert!(!looks_like(a, b), "{a} !~ {b}");
        }
    }

    // ---- 16 and 17 (UR-10, U25) ----

    #[test]
    fn ur4_closed_to_strangers_takes_only_the_redemptions_of_links() {
        let mut inner = me();
        receive(&mut inner, by_name(&create_identity(), "hola", NOW), NOW);
        receive(
            &mut inner,
            from(
                &create_identity(),
                "mara",
                link("Para Mara"),
                text("hola", NOW),
            ),
            NOW,
        );

        assert!(inner.requests.close_to_strangers());

        assert_eq!(inner.requests.len(), 1, "only the link's stays (U23)");
        assert!(inner.requests.closed_to_strangers());
        for via in [Via::Name, group(), Via::Code { label: "x".into() }] {
            let got = receive(
                &mut inner,
                from(&create_identity(), "x", via, text("hola", NOW + 1)),
                NOW + 1,
            );
            assert!(matches!(got, Received::Dropped(_)), "{got:?}");
        }
        let got = receive(
            &mut inner,
            from(&create_identity(), "x", link("y"), text("hola", NOW + 2)),
            NOW + 2,
        );
        assert_eq!(got, Received::New);
        assert_eq!(
            list(&inner, NOW + 2).overflow,
            0,
            "dropped in silence, not counted"
        );
        // Solicitudes says so (PropMenoresPC card 7).
        assert!(list(&inner, NOW + 2).only_links);
        assert!(!list(&me(), NOW).only_links);
    }

    // ---- On disk and in memory ----

    #[test]
    fn ur4_requests_are_sealed_in_the_store_and_come_back() {
        use crate::fsutil::scratch::ScratchDir;
        let scratch = ScratchDir::new("requests-bin");
        let mut inner = me();
        inner.storage = crate::store::session::testing::store_cell(scratch.path());
        let (ana, bob) = (create_identity(), create_identity());
        receive(&mut inner, by_name(&ana, "un texto para buscar", NOW), NOW);
        receive(&mut inner, by_name(&bob, "hola", NOW), NOW);
        delete(&mut inner, &ik(&bob), NOW).unwrap();
        try_save(&inner).unwrap();

        let raw = std::fs::read(scratch.path().join("store").join("requests.bin")).unwrap();
        assert!(!raw.windows(20).any(|w| w == b"un texto para buscar"));
        let mut again = me();
        let mut opened = crate::store::session::testing::reopen(scratch.path());
        load(&mut again, opened.session.take_requests(), NOW + 1);

        assert_eq!(again.requests.len(), 1);
        assert_eq!(
            list(&again, NOW + 1).requests[0].items,
            list(&inner, NOW + 1).requests[0].items
        );
        assert_eq!(list_deleted(&again, NOW + 1).len(), 1);
        // What expired meanwhile does not come back.
        let mut late = me();
        let mut opened = crate::store::session::testing::reopen(scratch.path());
        load(
            &mut late,
            opened.session.take_requests(),
            NOW + EXPIRES_AFTER,
        );
        assert!(late.requests.is_empty());
    }

    #[test]
    fn ur4_a_requests_bin_that_does_not_read_is_never_written_over() {
        let mut inner = me();
        load(
            &mut inner,
            Found::Ready(Zeroizing::new(b"{not json".to_vec())),
            NOW,
        );
        receive(&mut inner, by_name(&create_identity(), "hola", NOW), NOW);
        assert!(try_save(&inner).is_err());
        load(&mut inner, Found::Held, NOW);
        assert!(try_save(&inner).is_err());
        load(&mut inner, Found::Absent, NOW);
        assert!(try_save(&inner).is_ok(), "no session: nothing written");
    }

    #[test]
    fn ur4_an_item_does_not_print_its_text_or_file() {
        let shown = format!("{:?} {:?}", text("la clave es girasol", NOW), photo(NOW));
        assert!(!shown.contains("girasol"), "{shown}");
        assert!(!shown.contains("secret-url"), "{shown}");
        assert!(!shown.contains("THUMBNAIL"), "{shown}");
    }
}
