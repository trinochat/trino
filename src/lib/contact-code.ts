// Contact codes. `trino3:` (P1-13a) is the only one shared and added now:
// the backend makes it (share_bundle) and reads it (preview_contact); here
// it is read for its shape, and the codes of before are told apart so the
// screen can say so. `trino1:<base64url(bundle without avatar)>` is the JSON
// bundle, moved out of App.tsx unchanged; `trino2:` (T9) packs the same keys
// into a versioned binary, about 370 characters instead of 870, and is the
// only one shared now. Both, and a raw JSON bundle, are still read.
// contact-code.test.ts pins both formats.

/** UTF-8, then base64 with the URL-safe alphabet (- and _) and no = padding. */
export function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of `b64urlEncode`. Throws when the input is not base64url. */
export function b64urlDecode(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The `trino1:` code of a bundle as returned by `share_bundle`, or '' if it is not a JSON object. */
export function toCompactCode(bundleJson: string): string {
  try {
    const obj = JSON.parse(bundleJson);
    delete obj.avatar;
    return 'trino1:' + b64urlEncode(JSON.stringify(obj));
  } catch {
    return '';
  }
}

/** The bundle JSON inside a pasted `trino1:` code, or null if it is not one. */
export function fromCompactCode(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith('trino1:')) return null;
  try {
    return b64urlDecode(raw.slice(7));
  } catch {
    return null;
  }
}

/*
 * trino2: base64url, without padding, of these bytes (262 + L in all):
 *
 *   version    1 byte   1
 *   L          1 byte   length of the name, in bytes
 *   handle     L bytes  the name, UTF-8, cut at a whole character to 255 bytes
 *   ikSignPub  32       the identity signing key
 *   ikDhPub    32       the identity DH key
 *   nostrPub   32       the transport key
 *   spkId      4        the signed prekey's id, unsigned, big-endian
 *   spkPub     32       the signed prekey
 *   spkSig     64       its signature by ikSignPub
 *   idSig      64       ikSignPub's signature over ikDhPub and nostrPub
 *
 * Like trino1:, it leaves the avatar out. It also leaves out the one-time
 * prekey: share_bundle never offers one (public_bundle_for sets it to null),
 * and X3DH works without it. Read back, it gives the JSON share_bundle
 * prints, keys sorted as serde_json writes them, with no avatar. A reader
 * refuses another version, a length that does not add up and a name that is
 * not UTF-8; the backend checks the signatures (preview_contact).
 */

const V2_PREFIX = 'trino2:';
const V2_VERSION = 1;
/** The keys before and after spkId, in order, with their size in bytes. */
const V2_KEYS_BEFORE_SPK_ID = [
  ['ikSignPub', 32],
  ['ikDhPub', 32],
  ['nostrPub', 32],
] as const;
const V2_KEYS_AFTER_SPK_ID = [
  ['spkPub', 32],
  ['spkSig', 64],
  ['idSig', 64],
] as const;
/** The bytes after the name: 3 keys of 32, the id, 1 key of 32 and 2 signatures of 64. */
const V2_KEYS_LENGTH = 32 * 3 + 4 + 32 + 64 * 2;
const MAX_NAME_BYTES = 255;

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of a base64url text, with or without padding, or null if it is not one. */
function b64urlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  let b64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The bytes of a hex key of exactly `length` bytes, or null. */
function hexToBytes(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(value)) return null;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** The name in UTF-8, cut at a whole character to fit in `MAX_NAME_BYTES`. */
function nameBytes(name: string): Uint8Array {
  const encoder = new TextEncoder();
  const whole = encoder.encode(name);
  if (whole.length <= MAX_NAME_BYTES) return whole;
  let length = 0;
  let cut = '';
  for (const char of name) {
    const size = encoder.encode(char).length;
    if (length + size > MAX_NAME_BYTES) break;
    length += size;
    cut += char;
  }
  return encoder.encode(cut);
}

/**
 * The `trino2:` code of a bundle as returned by `share_bundle`, or '' if it
 * is not a whole bundle: every key in hex at its length and a 32-bit spkId.
 * A missing name counts as an empty one.
 */
export function toCompactCodeV2(bundleJson: string): string {
  let bundle: unknown;
  try {
    bundle = JSON.parse(bundleJson);
  } catch {
    return '';
  }
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return '';
  const fields = bundle as Record<string, unknown>;
  const spkId = fields.spkId;
  if (typeof spkId !== 'number' || !Number.isInteger(spkId) || spkId < 0 || spkId > 0xffffffff) return '';

  const name = nameBytes(typeof fields.handle === 'string' ? fields.handle : '');
  const out = new Uint8Array(2 + name.length + V2_KEYS_LENGTH);
  out[0] = V2_VERSION;
  out[1] = name.length;
  out.set(name, 2);
  let offset = 2 + name.length;
  const put = (keys: readonly (readonly [string, number])[]): boolean => {
    for (const [key, length] of keys) {
      const bytes = hexToBytes(fields[key], length);
      if (!bytes) return false;
      out.set(bytes, offset);
      offset += length;
    }
    return true;
  };
  if (!put(V2_KEYS_BEFORE_SPK_ID)) return '';
  new DataView(out.buffer).setUint32(offset, spkId, false);
  offset += 4;
  if (!put(V2_KEYS_AFTER_SPK_ID)) return '';
  return V2_PREFIX + bytesToB64url(out);
}

/** Whether a text is a JSON object with an identity key, as every bundle has. */
function isBundleJson(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).ikSignPub === 'string'
    );
  } catch {
    return false;
  }
}

/** A bundle pasted as JSON, as the first versions shared it. */
function readJson(input: string): string | null {
  const text = input.trim();
  return text.startsWith('{') && isBundleJson(text) ? text : null;
}

/**
 * A pasted `trino3:` code as the backend takes it: without spaces or line
 * breaks, its prefix in lower case; null if it is not a whole one.
 */
function readCodeV3(input: string): string | null {
  if (decodeCodeV3(input) === null) return null;
  const code = Array.from(input)
    .filter(char => char.trim() !== '')
    .join('');
  return V3_PREFIX + code.slice(V3_PREFIX.length);
}

export type ContactCodeFormat = 'trino3';

export interface ContactCodeReader {
  format: ContactCodeFormat;
  /** What goes to the backend for a pasted text, or null if the text is not this kind of code. */
  read(input: string): string | null;
}

/**
 * Every kind of code a pasted text can be, newest first: `trino3:` only
 * since P1-13a (the codes of before carry no prekeys of P1; the screen
 * tells them apart with isOldContactCode). The seam of the invitation
 * links (plan-cambios-11oct §8): a link becomes one more reader here, and
 * the screens that call parseContactCode stay as they are.
 */
export const CONTACT_CODE_READERS: readonly ContactCodeReader[] = [{ format: 'trino3', read: readCodeV3 }];

/**
 * What a pasted code sends to the backend (named `bundleJson`, as when it
 * was the bundle), and which kind of code it was, or null. Spaces and line
 * breaks inside a code are ignored, as when a chat app wraps it. Nothing
 * here checks the signatures: preview_contact does (K8).
 */
export function parseContactCode(input: string): { bundleJson: string; format: ContactCodeFormat } | null {
  for (const reader of CONTACT_CODE_READERS) {
    const bundleJson = reader.read(input);
    if (bundleJson !== null) return { bundleJson, format: reader.format };
  }
  return null;
}

/**
 * A key as people read it aloud: in capitals and groups of four, as
 * "7F3A 91C2 0B5E D4A8" for the backend's "7f3a.91c2.0b5e.d4a8".
 */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * The code the new screens share and show, from what share_bundle (or the
 * new account) gives: the `trino3:` code itself (P1-13a), trimmed, or ''
 * if it is not a whole one. W1's last step and the share panel import
 * this, so they follow it.
 */
export function toShareCode(shared: string): string {
  const code = shared.trim();
  return decodeCodeV3(code) !== null ? code : '';
}

/*
 * trino3: base64url, without padding, of these 434 bytes (P1-13a;
 * diseno-vinculacion.md §13.3), as crates/trino-engine/src/contact_code.rs
 * writes them:
 *
 *   version  1    1
 *   account  32   A, the account key
 *   gen      4    the generation of its list, big-endian
 *   seq      8    its seq, big-endian
 *   listHash 16   the first 16 bytes of the list's SHA-256
 *   entry    209  the primary's entry
 *   spk      100  the primary's signed prekey
 *   r        32   this code's request mailbox
 *   rDh      32   this code's request key
 *
 * No name, no photo and no device list. The backend checks the signatures.
 */

const V3_PREFIX = 'trino3:';
const V3_VERSION = 1;
const V3_ENTRY_LEN = 209;
const V3_SPK_LEN = 100;
export const V3_LENGTH = 1 + 32 + 4 + 8 + 16 + V3_ENTRY_LEN + V3_SPK_LEN + 32 + 32;

/** A `trino3:` code, its byte fields in lowercase hex. */
export interface CodeV3 {
  account: string;
  gen: number;
  seq: bigint;
  listHash: string;
  entry: string;
  spk: string;
  r: string;
  rDh: string;
}

/** The text of a `trino3:` code, or '' if a field is not hex of its length or a number out of range. */
export function encodeCodeV3(code: CodeV3): string {
  if (!Number.isInteger(code.gen) || code.gen < 0 || code.gen > 0xffffffff) return '';
  if (code.seq < 0n || code.seq > 0xffffffffffffffffn) return '';
  const out = new Uint8Array(V3_LENGTH);
  const view = new DataView(out.buffer);
  out[0] = V3_VERSION;
  let offset = 1;
  const put = (hex: string, length: number): boolean => {
    const bytes = hexToBytes(hex, length);
    if (!bytes) return false;
    out.set(bytes, offset);
    offset += length;
    return true;
  };
  if (!put(code.account, 32)) return '';
  view.setUint32(offset, code.gen, false);
  view.setBigUint64(offset + 4, code.seq, false);
  offset += 12;
  for (const [hex, length] of v3FieldsAfterSeq(code)) {
    if (!put(hex, length)) return '';
  }
  return V3_PREFIX + bytesToB64url(out);
}

/** The byte fields after `seq`, in order, with their length. */
function v3FieldsAfterSeq(code: CodeV3): [string, number][] {
  return [
    [code.listHash, 16],
    [code.entry, V3_ENTRY_LEN],
    [code.spk, V3_SPK_LEN],
    [code.r, 32],
    [code.rDh, 32],
  ];
}

/** A pasted `trino3:` code, spaces and line breaks ignored, or null if it is not a whole one of a known version. */
export function decodeCodeV3(input: string): CodeV3 | null {
  const code = input.replace(/\s+/g, '');
  if (code.slice(0, V3_PREFIX.length).toLowerCase() !== V3_PREFIX) return null;
  const text = code.slice(V3_PREFIX.length);
  // No padding: the code never has it (contact_code.rs refuses it too).
  if (text.includes('=')) return null;
  const bytes = b64urlToBytes(text);
  if (!bytes || bytes.length !== V3_LENGTH || bytes[0] !== V3_VERSION) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 1;
  const take = (length: number) => {
    const hex = bytesToHex(bytes.subarray(offset, offset + length));
    offset += length;
    return hex;
  };
  const account = take(32);
  const gen = view.getUint32(offset, false);
  const seq = view.getBigUint64(offset + 4, false);
  offset += 12;
  return {
    account,
    gen,
    seq,
    listHash: take(16),
    entry: take(V3_ENTRY_LEN),
    spk: take(V3_SPK_LEN),
    r: take(32),
    rDh: take(32),
  };
}

/**
 * Whether a pasted text is a code of before: `trino1:` or `trino2:` with
 * something after, or a bundle pasted as JSON. The screen says it is of an
 * earlier version instead of invalid.
 */
export function isOldContactCode(input: string): boolean {
  const code = input.replace(/\s+/g, '').toLowerCase();
  if (/^trino[12]:./.test(code)) return true;
  return readJson(input) !== null;
}
