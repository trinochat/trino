/**
 * SAS v2: the short authentication string two people compare to check that
 * nobody sits between them (docs/sas-v2.md, plan §6).
 *
 *   call:    d = SHA-256("trino-sas-call-v2" 0x00 callId 0x00 min(idA,idB) 0x00 max(idA,idB)
 *                        0x00 min(dtlsA,dtlsB) 0x00 max(dtlsA,dtlsB))
 *   contact: d = SHA-256("trino-sas-contact-v2" 0x00 min(idA,idB) 0x00 max(idA,idB))
 *   indices[i] = d[i] >> 2, for i = 0..6: 7 symbols of 6 bits, 42 bits in all.
 *
 * idX is an identity digest (64 lowercase hex digits): mine, and the one I
 * saved for the contact. dtlsX is a DTLS sha-256 fingerprint as `parseFp`
 * in call.ts gives it (64 lowercase hex digits, no colons). The pairs are
 * sorted, so both sides get the same result. Anything else is refused with
 * a SasInputError rather than quietly turned into symbols that cannot match.
 *
 * The indices pick symbols from the frozen table in sas-symbols.ts. The
 * mobile app implements the same function and must pass the same golden
 * vectors (assets/sas/vectors.json).
 */

export const SAS_LENGTH = 7;
export const SAS_ALPHABET_SIZE = 64;
export const SAS_CALL_DOMAIN = 'trino-sas-call-v2';
export const SAS_CONTACT_DOMAIN = 'trino-sas-contact-v2';

export interface CallSasInput {
  /** The call's id, as call.ts accepts it: 16 to 64 of A-Z, a-z, 0-9, `_` and `-`. */
  callId: string;
  /** Identity digests: mine and the contact's, in either order. */
  idA: string;
  idB: string;
  /** DTLS fingerprints: local and remote, in either order. */
  dtlsA: string;
  dtlsB: string;
}

export interface ContactSasInput {
  /** Identity digests: mine and the contact's, in either order. */
  idA: string;
  idB: string;
}

/** An input that is not in the exact form the derivation is defined on. */
export class SasInputError extends Error {
  override name = 'SasInputError';
}

const HEX64 = /^[0-9a-f]{64}$/;
/** The same rule as `validCallId` in call.ts. */
const CALL_ID = /^[A-Za-z0-9_-]{16,64}$/;

function hex64(field: string, value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new SasInputError(`${field} must be 64 lowercase hex digits`);
  }
  return value;
}

function callId(value: unknown): string {
  if (typeof value !== 'string' || !CALL_ID.test(value)) {
    throw new SasInputError('callId must be 16 to 64 characters of A-Z, a-z, 0-9, _ or -');
  }
  return value;
}

/** The pair as [min, max]; every value is ASCII, so this is plain byte order. */
function ordered(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** SHA-256 of the UTF-8 parts joined by single 0x00 bytes. */
async function digestOf(parts: string[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = parts.map(part => encoder.encode(part));
  const message = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0) + chunks.length - 1);
  let offset = 0;
  chunks.forEach((chunk, i) => {
    if (i > 0) offset += 1; // the 0x00 separator, already zero
    message.set(chunk, offset);
    offset += chunk.length;
  });
  return new Uint8Array(await crypto.subtle.digest('SHA-256', message));
}

/** The 32-byte digest behind a call's SAS. */
export async function callSasDigest(input: CallSasInput): Promise<Uint8Array> {
  const id = callId(input.callId);
  const [idLow, idHigh] = ordered(hex64('idA', input.idA), hex64('idB', input.idB));
  const [dtlsLow, dtlsHigh] = ordered(hex64('dtlsA', input.dtlsA), hex64('dtlsB', input.dtlsB));
  return digestOf([SAS_CALL_DOMAIN, id, idLow, idHigh, dtlsLow, dtlsHigh]);
}

/** The 32-byte digest behind a contact's SAS. */
export async function contactSasDigest(input: ContactSasInput): Promise<Uint8Array> {
  const [idLow, idHigh] = ordered(hex64('idA', input.idA), hex64('idB', input.idB));
  return digestOf([SAS_CONTACT_DOMAIN, idLow, idHigh]);
}

/** The first 7 bytes of a digest, each shifted right by 2: 7 indices from 0 to 63. */
export function sasIndices(digest: Uint8Array): number[] {
  if (digest.length < SAS_LENGTH) throw new RangeError(`a SAS needs at least ${SAS_LENGTH} digest bytes`);
  return Array.from(digest.subarray(0, SAS_LENGTH), byte => byte >> 2);
}

/** The 7 symbol indices both sides of a call compare. Rejects with SasInputError. */
export async function callSas(input: CallSasInput): Promise<number[]> {
  return sasIndices(await callSasDigest(input));
}

/** The 7 symbol indices two contacts compare to verify each other. Rejects with SasInputError. */
export async function contactSas(input: ContactSasInput): Promise<number[]> {
  return sasIndices(await contactSasDigest(input));
}
