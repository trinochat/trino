/**
 * Verifying a contact (W6): the contact's quick check, which never verifies,
 * the one-time notice about the marks of 0.1.0, and how marks are stored.
 */
export { VerifyContactDialog, type VerifyContactDialogProps } from './VerifyContactDialog';
export { LegacyVerificationNotice, type LegacyVerificationNoticeProps } from './LegacyVerificationNotice';
export { legacyMarks, markVerifies, readMark, verifiedMark, type ReadMark, type VerifiedBy } from './verification-marks';
