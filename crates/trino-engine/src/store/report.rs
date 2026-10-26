//! What the store found when it opened, for the one dialog at unlock (design
//! §6.1, §6.2 and §11.4). The store decides what to do with each file; the
//! dialog only shows it and asks where a choice is needed.

use super::envelope::Slot;
use serde::Serialize;

/// What happened to a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum What {
    /// It is older than the last copy Trino wrote.
    OlderCopy,
    /// Nothing could tell whether it is the last copy Trino wrote: the index
    /// is missing, does not open or is behind.
    Unverified,
    /// It does not open, or its header does not fit its place: changed,
    /// damaged or planted.
    Altered,
    /// The index lists it and it is gone.
    Missing,
    /// It opens, but the index does not list it: planted, or a removed file
    /// that came back.
    Unlisted,
    /// It could not be read now, most likely held by another program.
    Unreadable,
    /// The index is behind the files: nothing it says counts.
    Behind,
    /// `vault.bin` is not the one the index noted, and nothing explains it
    /// (design §4.9): another copy was put here.
    VaultChanged,
    /// The store belongs to another account: it was moved aside whole.
    OtherAccount,
    /// The TOTP flag of a version 1 vault, which nothing authenticates,
    /// said otherwise than the vault holds; sealed again, it is right
    /// (design §4.9).
    TotpFlag,
    /// Files of an earlier version, in clear, that nothing shows are this
    /// account's: they appeared after the migration, or there was no proof
    /// to migrate them (design §4.8). Trino did not open them.
    PlainFiles,
}

/// What the store did, or asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    /// Waits for "Usar" or "Seguir sin": not used, not written until then.
    Ask,
    /// Sessions are never reused: set aside, and made again with each
    /// contact.
    NewSessions,
    /// Moved to `aside/` as it was, unopened.
    SetAside,
    /// Used: a sticker opens only under its own name, so it can only be one
    /// the user had.
    Use,
    /// Starts empty.
    Empty,
    /// Starts with the default preferences.
    Defaults,
    /// Left as it is, unused and never written this session.
    KeepForLater,
    /// Nothing to do: only told.
    Notice,
    /// "Ver qué traen", "Importarlos" or "Borrarlos": nothing is read until
    /// the user picks one (design §4.8 and §11.4).
    OfferImport,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// The logical name, or `index`.
    pub file: String,
    pub what: What,
    pub action: Action,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub findings: Vec<Finding>,
}

impl IntegrityReport {
    pub fn is_empty(&self) -> bool {
        self.findings.is_empty()
    }

    /// Whether the user has to choose: then the one dialog asks, once, for
    /// everything that waits.
    #[cfg_attr(not(test), allow(dead_code))] // the dialog, CL-2b
    pub fn asks(&self) -> bool {
        self.findings
            .iter()
            .any(|finding| finding.action == Action::Ask)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn find(&self, file: &str) -> Option<&Finding> {
        self.findings.iter().find(|finding| finding.file == file)
    }

    /// A finding about something other than one file: the vault or the
    /// whole store.
    pub fn note(&mut self, file: &str, what: What, action: Action) {
        self.findings.push(Finding {
            file: file.to_string(),
            what,
            action,
        });
    }

    pub fn push(&mut self, slot: &Slot, what: What) {
        self.findings.push(Finding {
            file: slot.logical_name(),
            what,
            action: action_for(slot, what),
        });
    }
}

/// Design §6.1: what each kind of file gets in each case.
pub fn action_for(slot: &Slot, what: What) -> Action {
    match (what, slot) {
        (What::Unreadable, _) => Action::KeepForLater,
        (What::VaultChanged | What::TotpFlag, _) => Action::Notice,
        (What::OtherAccount, _) => Action::SetAside,
        (What::PlainFiles, _) => Action::OfferImport,
        (_, Slot::Index) => Action::Notice,
        (_, Slot::Sessions) => Action::NewSessions,
        (What::OlderCopy, Slot::Sticker(_)) => Action::SetAside,
        (What::Unverified | What::Behind, Slot::Sticker(_)) => Action::Use,
        // Requests (UR-4) hold what strangers sent: never worth a question.
        (What::OlderCopy, Slot::Requests) => Action::SetAside,
        (What::Unverified | What::Behind, Slot::Requests) => Action::Use,
        (What::OlderCopy | What::Unverified | What::Behind, _) => Action::Ask,
        (What::Altered | What::Unlisted, _) => Action::SetAside,
        (What::Missing, Slot::Prefs) => Action::Defaults,
        (What::Missing, Slot::Sticker(_)) => Action::Notice,
        (What::Missing, _) => Action::Empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table of design §6.1.
    #[test]
    fn each_kind_gets_what_the_design_table_says() {
        let sticker = Slot::Sticker("00".repeat(16));
        use Action::*;
        let rows = [
            (What::OlderCopy, [Ask, Ask, Ask, NewSessions, Ask, SetAside]),
            (What::Unverified, [Ask, Ask, Ask, NewSessions, Ask, Use]),
            (
                What::Altered,
                [
                    SetAside,
                    SetAside,
                    SetAside,
                    NewSessions,
                    SetAside,
                    SetAside,
                ],
            ),
            (
                What::Missing,
                [Empty, Defaults, Empty, NewSessions, Empty, Notice],
            ),
        ];
        for (what, expected) in rows {
            let slots = [
                Slot::Account,
                Slot::Prefs,
                Slot::History,
                Slot::Sessions,
                Slot::Profiles,
                sticker.clone(),
            ];
            for (slot, action) in slots.iter().zip(expected) {
                assert_eq!(action_for(slot, what), action, "{what:?} {slot:?}");
            }
        }
        assert_eq!(action_for(&Slot::Account, What::Unreadable), KeepForLater);
        assert_eq!(action_for(&Slot::Index, What::Altered), Notice);
    }

    /// Requests (UR-4) hold what strangers sent: an older or unverified
    /// copy never asks. The older one is set aside, the unverified one used.
    #[test]
    fn ur4_requests_never_ask() {
        use Action::*;
        let rows = [
            (What::OlderCopy, SetAside),
            (What::Unverified, Use),
            (What::Behind, Use),
            (What::Altered, SetAside),
            (What::Unlisted, SetAside),
            (What::Missing, Empty),
            (What::Unreadable, KeepForLater),
        ];
        for (what, action) in rows {
            assert_eq!(action_for(&Slot::Requests, what), action, "{what:?}");
        }
    }

    #[test]
    fn the_report_reaches_the_frontend_in_camel_case() {
        let mut report = IntegrityReport::default();
        report.push(&Slot::Account, What::OlderCopy);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "findings": [{ "file": "account", "what": "olderCopy", "action": "ask" }]
            })
        );
        assert!(report.asks());
    }
}
