/**
 * Verifying a contact (W6): the contact's quick check, which never verifies,
 * and the one-time notice about the marks of 0.1.0. How marks are stored is
 * src/lib/verification-marks.ts, which prefs.ts reads and writes them with.
 */
export { VerifyContactDialog, type VerifyContactDialogProps } from './VerifyContactDialog';
export { LegacyVerificationNotice, type LegacyVerificationNoticeProps } from './LegacyVerificationNotice';
