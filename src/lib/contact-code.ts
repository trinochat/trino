// Contact codes. `trino1:<base64url(bundle without avatar)>` is the JSON
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

/** The bundle JSON inside a `trino2:` code, or null if it is not a whole one of a known version. */
function readCodeV2(input: string): string | null {
  const code = input.replace(/\s+/g, '');
  if (code.slice(0, V2_PREFIX.length).toLowerCase() !== V2_PREFIX) return null;
  const bytes = b64urlToBytes(code.slice(V2_PREFIX.length));
  if (!bytes || bytes.length < 2 || bytes[0] !== V2_VERSION) return null;
  const nameLength = bytes[1]!;
  if (bytes.length !== 2 + nameLength + V2_KEYS_LENGTH) return null;
  let handle: string;
  try {
    handle = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2, 2 + nameLength));
  } catch {
    return null;
  }
  const keys: Record<string, string> = {};
  let offset = 2 + nameLength;
  const take = (list: readonly (readonly [string, number])[]) => {
    for (const [key, length] of list) {
      keys[key] = bytesToHex(bytes.subarray(offset, offset + length));
      offset += length;
    }
  };
  take(V2_KEYS_BEFORE_SPK_ID);
  const spkId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
  offset += 4;
  take(V2_KEYS_AFTER_SPK_ID);
  // The keys in the order serde_json prints share_bundle's (sorted), with the
  // one-time prekey it never offers.
  return JSON.stringify({
    handle,
    idSig: keys.idSig,
    ikDhPub: keys.ikDhPub,
    ikSignPub: keys.ikSignPub,
    nostrPub: keys.nostrPub,
    opkId: null,
    opkPub: null,
    spkId,
    spkPub: keys.spkPub,
    spkSig: keys.spkSig,
  });
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

/** The bundle JSON inside a `trino1:` code, or null if it is not one or holds no bundle. */
function readCodeV1(input: string): string | null {
  const code = input.replace(/\s+/g, '');
  if (code.slice(0, 7).toLowerCase() !== 'trino1:') return null;
  const json = fromCompactCode('trino1:' + code.slice(7));
  return json !== null && isBundleJson(json) ? json : null;
}

/** A bundle pasted as JSON, as the first versions shared it. */
function readJson(input: string): string | null {
  const text = input.trim();
  return text.startsWith('{') && isBundleJson(text) ? text : null;
}

export type ContactCodeFormat = 'trino2' | 'trino1' | 'json';

export interface ContactCodeReader {
  format: ContactCodeFormat;
  /** The bundle JSON in a pasted text, or null if the text is not this kind of code. */
  read(input: string): string | null;
}

/**
 * Every kind of code a pasted text can be, newest first. The seam of the
 * invitation links (plan-cambios-11oct §8): a link becomes one more reader
 * here, and the screens that call parseContactCode stay as they are.
 */
export const CONTACT_CODE_READERS: readonly ContactCodeReader[] = [
  { format: 'trino2', read: readCodeV2 },
  { format: 'trino1', read: readCodeV1 },
  { format: 'json', read: readJson },
];

/**
 * The bundle in a pasted code, and which kind of code it was, or null.
 * Spaces and line breaks inside a code are ignored, as when a chat app wraps
 * it. Nothing here checks the signatures: preview_contact does (K8).
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
 * The code the new screens share and show: `trino2:` only. W1's last step
 * and the share panel import this, so they follow it.
 */
export const toShareCode: (bundleJson: string) => string = toCompactCodeV2;
