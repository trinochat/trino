/**
 * How a contact's verification is stored, as the value of
 * `verified:<handle>` (src/lib/prefs.ts), and how the marks of 0.1.0 are told
 * apart (docs/sas-v2.md, "Marks made before v2").
 *
 * A contact is verified only by "Coinciden" on a call's SAS, or by scanning
 * in person a QR with the full identity digest (David, 10 Oct). The mark
 * says which, then the contact's fingerprint at that moment: `call:<fp>` or
 * `qr:<fp>`. 0.1.0 stored the bare fingerprint after comparing the contact's
 * 6 emojis, a check that about 2^18 offline work beats: those marks no
 * longer count, and the person is told once.
 *
 * Fingerprints are 16 lowercase hex digits in groups of 4 joined by dots
 * (`fp` in src-tauri/src/commands.rs), never with a colon, so the two forms
 * cannot be confused. Pure: prefs.ts writes and reads every mark through it
 * (`setVerified`, `isVerified`, `legacyVerified`).
 */

export type VerifiedBy = 'call' | 'qr';

const METHODS: readonly VerifiedBy[] = ['call', 'qr'];

export type ReadMark =
  | { kind: 'verified'; by: VerifiedBy; fingerprint: string }
  /** A mark of 0.1.0, or one this version cannot read: it does not count. */
  | { kind: 'legacy' }
  | { kind: 'none' };

/** The value to store for a contact verified now, with its current fingerprint. */
export function verifiedMark(fingerprint: string, by: VerifiedBy): string {
  return `${by}:${fingerprint}`;
}

/** What a stored value says. */
export function readMark(value: string | null | undefined): ReadMark {
  if (!value) return { kind: 'none' };
  const colon = value.indexOf(':');
  const by = value.slice(0, colon) as VerifiedBy;
  const fingerprint = value.slice(colon + 1);
  if (colon > 0 && METHODS.includes(by) && fingerprint) return { kind: 'verified', by, fingerprint };
  return { kind: 'legacy' };
}

/** Verified: by a call or a QR, and with the fingerprint the contact still has. */
export function markVerifies(value: string | null | undefined, fingerprint: string): boolean {
  const mark = readMark(value);
  return mark.kind === 'verified' && fingerprint !== '' && mark.fingerprint === fingerprint;
}

/** The contacts whose mark comes from 0.1.0, in the order given: who the one-time notice names. */
export function legacyMarks(marks: Iterable<readonly [handle: string, value: string | null | undefined]>): string[] {
  const legacy: string[] = [];
  for (const [handle, value] of marks) if (readMark(value).kind === 'legacy') legacy.push(handle);
  return legacy;
}
