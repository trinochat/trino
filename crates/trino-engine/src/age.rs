//! The account's age (uso responsable UR-10, point 10; U16, U17, U22, U23,
//! U25 and the minimum of 16, David, 25 Oct).
//!
//! - **Only a range, only on this device**: "16 o 17" or "18 o más", kept in
//!   `account.bin`, sealed with the rest of the account, and never sent to
//!   any server. Under 16 no account is made (the UI stops before).
//! - **16 or 17: the most protective, with no switch to turn it off**: only
//!   the redemptions of your own links reach Solicitudes; what comes by your
//!   code, your @name or from someone of a group is dropped in silence
//!   (`RequestBook::close_to_strangers`, U22, U25). No @name and no public
//!   card, and the approval of links always on (`Protections`), for the
//!   invitations' unit to read (INV).
//! - **Correcting it** (U17): from "18 o más" to "16 o 17" at once, which
//!   drops the requests that did not come by your links (U23); from "16 o
//!   17" to "18 o más" in 7 days, cancellable, or at once in the first 24
//!   hours of the account (whoever tapped wrong).
//! - **On a phone** the age range of Apple or Google comes with the mobile
//!   engine: then it is the store's (`Source::Store`), it is read again as
//!   the app opens, and Trino offers no change (U16). The desktop has no
//!   such signal: only the person's own answer.
//! - An account of before UR-10 had to tick "Tengo 18 años o más": with no
//!   age kept, it reads as 18 or more.

use crate::command_error::CommandError;
use crate::state::InnerState;
use serde::{Deserialize, Serialize};

const DAY: i64 = 24 * 60 * 60;
/// From "16 o 17" to "18 o más" takes this long (U17).
pub const WAIT: i64 = 7 * DAY;
/// Within this long of making the account, a correction is at once (U17).
pub const INSTANT_WINDOW: i64 = DAY;

/// The range the account said.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bracket {
    /// 16 or 17.
    Minor,
    /// 18 or more.
    Adult,
}

/// Who said it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The person, when the account was made or in Ajustes › Edad.
    #[default]
    SelfDeclared,
    /// The phone's age range (Apple's Declared Age Range, Google's store),
    /// with the mobile engine: corrected in the phone's account, not here.
    Store,
}

/// What `account.bin` keeps of the age.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Age {
    pub bracket: Bracket,
    #[serde(default)]
    pub source: Source,
    pub declared_at: i64,
    /// "18 o más" asked for: from then on (U17). Cancellable until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adult_from: Option<i64>,
}

/// What the protections of 16 and 17 mean for what is not built yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Protections {
    /// Only the redemptions of your own links reach Solicitudes.
    pub closed_to_strangers: bool,
    /// An @name and a public card can exist.
    pub name_allowed: bool,
    /// The approval of your links cannot be turned off.
    pub link_approval_fixed: bool,
}

/// What Ajustes › Edad shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgeView {
    pub bracket: Bracket,
    /// When "18 o más" takes effect, if asked for and not yet.
    pub adult_from: Option<i64>,
    /// A change to "18 o más" now would be at once (the first 24 hours).
    pub instant: bool,
    /// Said by the phone: Trino offers no change.
    pub from_store: bool,
}

/// The range in force at `now`: a change to "18 o más" counts once due.
pub fn bracket(inner: &InnerState, now: i64) -> Bracket {
    match &inner.age {
        // An account of before UR-10 ticked "Tengo 18 años o más".
        None => Bracket::Adult,
        Some(age) if age.adult_from.is_some_and(|from| now >= from) => Bracket::Adult,
        Some(age) => age.bracket,
    }
}

/// What applies at `now`.
pub fn protections(inner: &InnerState, now: i64) -> Protections {
    let minor = bracket(inner, now) == Bracket::Minor;
    Protections {
        closed_to_strangers: minor,
        name_allowed: !minor,
        link_approval_fixed: minor,
    }
}

/// The answer given when the account was made, and its protections.
pub fn declare(inner: &mut InnerState, bracket: Bracket, now: i64) {
    inner.age = Some(Age {
        bracket,
        source: Source::SelfDeclared,
        declared_at: now,
        adult_from: None,
    });
    apply(inner, now);
}

/// As a session opens and as time passes: a change due takes effect, and
/// the protections of 16 and 17 are set. Whether what is kept changed.
pub fn apply(inner: &mut InnerState, now: i64) -> bool {
    let mut changed = false;
    if let Some(age) = inner.age.as_mut() {
        if age.adult_from.is_some_and(|from| now >= from) {
            age.bracket = Bracket::Adult;
            age.declared_at = age.adult_from.take().unwrap_or(now);
            changed = true;
        }
    }
    match bracket(inner, now) {
        Bracket::Minor => {
            inner.requests.close_to_strangers();
        }
        Bracket::Adult => inner.requests.open_to_strangers(),
    }
    changed
}

/// Ajustes › Edad: change to `to` (U17, U23). To "16 o 17", at once: the
/// requests that did not come by your links go (U23); an @name and a public
/// card, once they exist (INV), are let go here too. To "18 o más", in 7
/// days, or at once in the first 24 hours of the account.
pub fn change(inner: &mut InnerState, to: Bracket, now: i64) -> Result<AgeView, CommandError> {
    if inner
        .age
        .as_ref()
        .is_some_and(|age| age.source == Source::Store)
    {
        return Err(CommandError::internal(
            "the phone says the age: it is corrected in the phone's account",
        ));
    }
    let current = bracket(inner, now);
    let age = inner.age.get_or_insert(Age {
        bracket: current,
        source: Source::SelfDeclared,
        declared_at: now,
        adult_from: None,
    });
    match (current, to) {
        (_, Bracket::Minor) => {
            age.bracket = Bracket::Minor;
            age.declared_at = now;
            age.adult_from = None;
        }
        (Bracket::Minor, Bracket::Adult) if now - inner.created_at < INSTANT_WINDOW => {
            age.bracket = Bracket::Adult;
            age.declared_at = now;
            age.adult_from = None;
        }
        (Bracket::Minor, Bracket::Adult) => {
            age.adult_from.get_or_insert(now + WAIT);
        }
        (Bracket::Adult, Bracket::Adult) => {}
    }
    apply(inner, now);
    Ok(view(inner, now))
}

/// Cancel a change to "18 o más" that waits.
pub fn cancel_change(inner: &mut InnerState, now: i64) -> Result<AgeView, CommandError> {
    if let Some(age) = inner.age.as_mut() {
        if age.adult_from.is_some_and(|from| now < from) {
            age.adult_from = None;
        }
    }
    Ok(view(inner, now))
}

/// What Ajustes › Edad shows at `now`.
pub fn view(inner: &InnerState, now: i64) -> AgeView {
    let pending = inner
        .age
        .as_ref()
        .and_then(|age| age.adult_from)
        .filter(|from| now < *from);
    AgeView {
        bracket: bracket(inner, now),
        adult_from: pending,
        instant: now - inner.created_at < INSTANT_WINDOW,
        from_store: inner
            .age
            .as_ref()
            .is_some_and(|age| age.source == Source::Store),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{create_identity, public_bundle_for};
    use crate::requests::{receive, Incoming, Item, Received, Via};

    const NOW: i64 = 1_791_900_000;

    fn account(created_at: i64) -> InnerState {
        InnerState {
            identity: Some(create_identity()),
            created_at,
            ..InnerState::default()
        }
    }

    fn incoming(via: Via, text: &str) -> Incoming {
        Incoming {
            bundle: public_bundle_for(&create_identity()),
            name: "ana".into(),
            via,
            item: Item::Text {
                text: text.into(),
                at: NOW,
            },
            nostr_proven: true,
            dh_proven: true,
        }
    }

    fn link() -> Via {
        Via::Link {
            label: "Para Mara".into(),
        }
    }

    /// U25, U22: an account of 16 or 17 takes only its links' redemptions;
    /// the rest goes in silence. No @name, the approval of links fixed.
    #[test]
    fn ur10_sixteen_or_seventeen_takes_only_its_links() {
        let mut inner = account(NOW);
        declare(&mut inner, Bracket::Minor, NOW);
        assert_eq!(bracket(&inner, NOW), Bracket::Minor);
        assert_eq!(
            protections(&inner, NOW),
            Protections {
                closed_to_strangers: true,
                name_allowed: false,
                link_approval_fixed: true
            }
        );
        assert!(matches!(
            receive(&mut inner, incoming(Via::Name, "hola"), NOW),
            Received::Dropped(_)
        ));
        let group = Via::Group {
            gid: "g1".into(),
            group: "Curso".into(),
        };
        assert!(matches!(
            receive(&mut inner, incoming(group, "hola"), NOW),
            Received::Dropped(_)
        ));
        assert_eq!(
            receive(&mut inner, incoming(link(), "soy Mara"), NOW),
            Received::New
        );
    }

    #[test]
    fn eighteen_or_more_has_no_restriction() {
        let mut inner = account(NOW);
        declare(&mut inner, Bracket::Adult, NOW);
        assert_eq!(
            protections(&inner, NOW),
            Protections {
                closed_to_strangers: false,
                name_allowed: true,
                link_approval_fixed: false
            }
        );
        assert_eq!(
            receive(&mut inner, incoming(Via::Name, "hola"), NOW),
            Received::New
        );
    }

    /// An account of before UR-10 ticked "Tengo 18 años o más".
    #[test]
    fn an_account_of_before_reads_as_eighteen_or_more() {
        let inner = account(NOW);
        assert_eq!(bracket(&inner, NOW), Bracket::Adult);
        assert_eq!(view(&inner, NOW).bracket, Bracket::Adult);
    }

    /// U17: from 16 or 17 to 18 or more, 7 days later, cancellable; until
    /// then everything stays as it was.
    #[test]
    fn ur10_to_eighteen_waits_seven_days_and_can_be_cancelled() {
        let mut inner = account(NOW - 3 * DAY);
        declare(&mut inner, Bracket::Minor, NOW - 3 * DAY);
        apply(&mut inner, NOW);
        let asked = change(&mut inner, Bracket::Adult, NOW).unwrap();
        assert_eq!(asked.bracket, Bracket::Minor, "not yet");
        assert_eq!(asked.adult_from, Some(NOW + WAIT));
        assert!(!asked.instant);
        assert!(!apply(&mut inner, NOW + WAIT - 1));
        assert_eq!(bracket(&inner, NOW + WAIT - 1), Bracket::Minor);
        assert!(protections(&inner, NOW + WAIT - 1).closed_to_strangers);

        let cancelled = cancel_change(&mut inner, NOW + 10).unwrap();
        assert_eq!(cancelled.adult_from, None);
        assert!(!apply(&mut inner, NOW + WAIT));
        assert_eq!(bracket(&inner, NOW + WAIT), Bracket::Minor);

        change(&mut inner, Bracket::Adult, NOW + WAIT).unwrap();
        assert!(apply(&mut inner, NOW + 2 * WAIT), "it took effect");
        assert_eq!(bracket(&inner, NOW + 2 * WAIT), Bracket::Adult);
        assert_eq!(inner.age.as_ref().unwrap().adult_from, None);
        assert!(!inner.requests.closed_to_strangers(), "open again");
    }

    /// U17: in the first 24 hours of the account, at once.
    #[test]
    fn ur10_in_the_first_day_it_is_at_once() {
        let mut inner = account(NOW);
        declare(&mut inner, Bracket::Minor, NOW);
        apply(&mut inner, NOW);
        assert!(view(&inner, NOW + DAY - 1).instant);
        let changed = change(&mut inner, Bracket::Adult, NOW + DAY - 1).unwrap();
        assert_eq!(changed.bracket, Bracket::Adult);
        assert_eq!(changed.adult_from, None);
        assert!(!inner.requests.closed_to_strangers());
    }

    /// U23: from 18 or more to 16 or 17, at once: the requests that did not
    /// come by your links go; the contacts and chats stay.
    #[test]
    fn ur10_to_sixteen_is_at_once_and_drops_the_requests_of_strangers() {
        let mut inner = account(NOW - 10 * DAY);
        declare(&mut inner, Bracket::Adult, NOW - 10 * DAY);
        receive(&mut inner, incoming(Via::Name, "hola"), NOW);
        receive(&mut inner, incoming(link(), "soy Mara"), NOW);
        inner.friends.insert(
            "bea".into(),
            crate::session::tests::friend(&create_identity(), "bea"),
        );
        let changed = change(&mut inner, Bracket::Minor, NOW).unwrap();
        assert_eq!(changed.bracket, Bracket::Minor);
        assert_eq!(inner.requests.len(), 1, "only the link's");
        assert_eq!(inner.friends.len(), 1, "contacts stay");
        assert!(protections(&inner, NOW).closed_to_strangers);
    }

    /// With the phone's signal, Trino offers no change (U16).
    #[test]
    fn the_phones_signal_is_not_changed_here() {
        let mut inner = account(NOW);
        inner.age = Some(Age {
            bracket: Bracket::Minor,
            source: Source::Store,
            declared_at: NOW,
            adult_from: None,
        });
        assert!(view(&inner, NOW).from_store);
        assert!(change(&mut inner, Bracket::Adult, NOW).is_err());
    }

    /// Every session applies the age as it opens: a change due takes
    /// effect, and an account of 16 or 17 is closed to strangers from the
    /// first event (`storage::apply_loaded`); the new account gets its
    /// answer before anything reaches it (`account::forge_identity`).
    #[test]
    fn every_session_applies_the_age_as_it_opens() {
        let code = |source: &str, function: &str| -> String {
            let start = source
                .find(function)
                .unwrap_or_else(|| panic!("{function}"));
            let rest = &source[start..];
            rest[..rest
                .find(
                    "
}
",
                )
                .unwrap()]
                .to_string()
        };
        let storage = code(include_str!("storage.rs"), "pub fn apply_loaded(");
        assert!(
            storage.contains("crate::age::apply(inner, now)"),
            "apply_loaded"
        );
        let account = code(include_str!("account.rs"), "pub async fn forge_identity(");
        assert!(account.contains("crate::age::declare("), "forge_identity");
    }

    /// Kept in account.bin; never more than the range and its dates.
    #[test]
    fn the_age_is_kept_with_the_account_and_says_only_the_range() {
        let mut inner = account(NOW);
        declare(&mut inner, Bracket::Minor, NOW);
        let json = serde_json::to_value(crate::storage::account_of(&inner)).unwrap();
        assert_eq!(
            json["age"],
            serde_json::json!({ "bracket": "minor", "source": "self_declared", "declaredAt": NOW })
        );
        let back: crate::store::session::AccountFile = serde_json::from_value(json).unwrap();
        assert_eq!(back.age, inner.age);
        let mut none = account(NOW);
        none.age = None;
        let json = serde_json::to_value(crate::storage::account_of(&none)).unwrap();
        assert!(json.get("age").is_none());
    }
}
