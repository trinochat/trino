//! TOTP enrollment while an identity is created.
//!
//! The secret is set up before the vault exists, and only sealed into it once
//! the user has typed a valid code from it: `totp_begin` creates the secret,
//! `totp_verify` confirms it, and `forge` seals the confirmed one. A secret
//! nobody has confirmed would lock its user out for good if they never added
//! it to their app.
//!
//! The pending secret lives in memory only, never on disk, and is wiped when
//! it is replaced, used or dropped.

use crate::command_error::{CommandError, ErrorCode};
use crate::totp::{generate_totp_secret, is_totp_code_valid, otpauth_uri, to_base32};
use serde::Serialize;
use zeroize::Zeroizing;

/// The name authenticator apps show above the code.
pub const TOTP_ISSUER: &str = "trino";

/// What the user adds to their authenticator app: as a QR code, or typed in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TotpBeginResponse {
    pub otpauth_uri: String,
    pub secret_base32: String,
}

/// The TOTP secret being set up, if any.
#[derive(Default)]
pub struct TotpEnrollment {
    pending: Option<Pending>,
}

struct Pending {
    secret: Zeroizing<Vec<u8>>,
    verified: bool,
}

impl TotpEnrollment {
    /// Start over with a new secret for the account called `label`. Any
    /// secret pending before is wiped, confirmed or not.
    pub fn begin(&mut self, label: &str) -> TotpBeginResponse {
        let secret = Zeroizing::new(generate_totp_secret());
        let begun = TotpBeginResponse {
            otpauth_uri: otpauth_uri(&secret, label, TOTP_ISSUER),
            secret_base32: to_base32(&secret),
        };
        self.pending = Some(Pending {
            secret,
            verified: false,
        });
        begun
    }

    /// Whether `code` is valid for the pending secret now, in the core's
    /// window: the current 30-second step and the one on each side. A valid
    /// code confirms the secret; a wrong one later does not undo that.
    pub fn verify(&mut self, code: &str) -> Result<bool, CommandError> {
        let pending = self.pending.as_mut().ok_or_else(|| {
            CommandError::new(
                ErrorCode::TotpNotVerified,
                "no TOTP secret is being set up; call totp_begin first",
            )
        })?;
        let valid = is_totp_code_valid(code, &pending.secret);
        pending.verified |= valid;
        Ok(valid)
    }

    /// The pending secret, once a code has confirmed it: the only one `forge`
    /// may seal a vault with.
    pub fn verified_secret(&self) -> Result<&[u8], CommandError> {
        match &self.pending {
            Some(pending) if pending.verified => Ok(&pending.secret),
            _ => Err(CommandError::new(
                ErrorCode::TotpNotVerified,
                "no TOTP secret has been confirmed with a code",
            )),
        }
    }

    /// Forget the pending secret, wiping it.
    pub fn clear(&mut self) {
        self.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::totp::{totp_code, totp_now};

    fn pending_secret(enrollment: &TotpEnrollment) -> Vec<u8> {
        enrollment
            .pending
            .as_ref()
            .expect("a pending secret")
            .secret
            .to_vec()
    }

    /// A six-digit code that is valid for `secret` at none of the steps the
    /// check accepts right now.
    fn wrong_code(secret: &[u8]) -> String {
        let now = chrono::Utc::now().timestamp();
        let valid: Vec<String> = [-60, -30, 0, 30, 60]
            .iter()
            .map(|offset| totp_code(secret, (now + offset) as u64, 6, 30))
            .collect();
        ["000000", "111111", "222222", "333333", "444444", "555555"]
            .into_iter()
            .find(|code| !valid.iter().any(|v| v == code))
            .unwrap()
            .to_string()
    }

    fn not_verified(result: Result<impl std::fmt::Debug, CommandError>) -> bool {
        matches!(
            result,
            Err(CommandError {
                code: ErrorCode::TotpNotVerified,
                ..
            })
        )
    }

    #[test]
    fn verifying_before_any_begin_is_an_error_not_a_wrong_code() {
        let mut enrollment = TotpEnrollment::default();
        assert!(not_verified(enrollment.verify("123456")));
        assert!(not_verified(enrollment.verified_secret()));
    }

    #[test]
    fn only_a_right_code_confirms_the_pending_secret() {
        let mut enrollment = TotpEnrollment::default();
        enrollment.begin("ana");
        let secret = pending_secret(&enrollment);

        assert_eq!(enrollment.verify(&wrong_code(&secret)), Ok(false));
        assert_eq!(enrollment.verify("12345"), Ok(false));
        assert!(not_verified(enrollment.verified_secret()));

        assert_eq!(enrollment.verify(&totp_now(&secret)), Ok(true));
        assert_eq!(enrollment.verified_secret(), Ok(secret.as_slice()));

        // Once confirmed, a later mistake does not undo it.
        assert_eq!(enrollment.verify(&wrong_code(&secret)), Ok(false));
        assert_eq!(enrollment.verified_secret(), Ok(secret.as_slice()));
    }

    #[test]
    fn a_new_begin_replaces_the_pending_secret_and_its_confirmation() {
        let mut enrollment = TotpEnrollment::default();
        let first = enrollment.begin("ana");
        let first_secret = pending_secret(&enrollment);
        assert_eq!(enrollment.verify(&totp_now(&first_secret)), Ok(true));

        let second = enrollment.begin("ana");

        assert_ne!(second.secret_base32, first.secret_base32);
        assert_ne!(pending_secret(&enrollment), first_secret);
        assert!(not_verified(enrollment.verified_secret()));
    }

    #[test]
    fn the_uri_carries_the_same_secret_and_the_account_name() {
        let mut enrollment = TotpEnrollment::default();
        let begun = enrollment.begin("María José");

        assert_eq!(
            begun.secret_base32,
            crate::totp::to_base32(&pending_secret(&enrollment))
        );
        assert_eq!(begun.secret_base32.len(), 32, "20 random bytes");
        assert_eq!(
            begun.otpauth_uri,
            format!(
                "otpauth://totp/trino:Mar%C3%ADa%20Jos%C3%A9?secret={}&issuer=trino&algorithm=SHA1&digits=6&period=30",
                begun.secret_base32
            )
        );
    }

    #[test]
    fn clear_forgets_the_pending_secret() {
        let mut enrollment = TotpEnrollment::default();
        enrollment.begin("ana");
        let secret = pending_secret(&enrollment);
        assert_eq!(enrollment.verify(&totp_now(&secret)), Ok(true));

        enrollment.clear();

        assert!(not_verified(enrollment.verified_secret()));
        assert!(not_verified(enrollment.verify(&totp_now(&secret))));
    }
}
