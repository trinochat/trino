import { describe, expect, it } from 'vitest';
import {
  CONTACT_CODE_READERS,
  V3_LENGTH,
  b64urlDecode,
  decodeCodeV3,
  encodeCodeV3,
  isOldContactCode,
  b64urlEncode,
  formatFingerprint,
  fromCompactCode,
  parseContactCode,
  toCompactCode,
  toCompactCodeV2,
  toShareCode,
} from './contact-code';
import { SAMPLE_CODE_V3 } from './contact-code-test-support';

// Characterization of the `trino1:` contact code as App.tsx produced it at
// e5794e2. The expected values come from running that code on this sample, so
// a failure here means codes that people already shared would stop matching.
// `trino2:` is a separate format and must not change these.

/** The shape of `share_bundle` (PublicBundle plus handle and avatar), with made-up keys. */
const SAMPLE_BUNDLE = JSON.stringify({
  ikSignPub: '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29',
  ikDhPub: '8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f',
  nostrPub: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  spkId: 3,
  spkPub: 'e7a1c2f04d5b6e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f',
  spkSig: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  opkId: 17,
  opkPub: '5c4b3a29180f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d',
  idSig: 'd4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9',
  handle: 'María 🐦',
  avatar: 'data:image/png;base64,iVBORw0KGgo=',
});

/** `toCompactCode(SAMPLE_BUNDLE)` as computed by the code at e5794e2. */
const SAMPLE_CODE = [
  'trino1:eyJpa1NpZ25QdWIiOiIzYjZhMjdiY2NlYjZhNDJkNjJhM2E4ZDAyYTZmMGQ3MzY1M',
  'zIxNTc3MWRlMjQzYTYzYWMwNDhhMThiNTlkYTI5IiwiaWtEaFB1YiI6IjhmNDBjNWFkYjY4Z',
  'jI1NjI0YWU1YjIxNGVhNzY3YTZlYzk0ZDgyOWQzZDdiNWUxYWQxYmE2ZjNlMjEzODI4NWYiL',
  'CJub3N0clB1YiI6ImExYjJjM2Q0ZTVmNjA3MTgyOTNhNGI1YzZkN2U4ZjkwYTFiMmMzZDRlN',
  'WY2MDcxODI5M2E0YjVjNmQ3ZThmOTAiLCJzcGtJZCI6Mywic3BrUHViIjoiZTdhMWMyZjA0Z',
  'DViNmU4ZjlhMGIxYzJkM2U0ZjVhNmI3YzhkOWUwZjFhMmIzYzRkNWU2ZjdhOGI5YzBkMWUyZ',
  'iIsInNwa1NpZyI6IjBmMWUyZDNjNGI1YTY5Nzg4Nzk2YTViNGMzZDJlMWYwMGYxZTJkM2M0Y',
  'jVhNjk3ODg3OTZhNWI0YzNkMmUxZjAiLCJvcGtJZCI6MTcsIm9wa1B1YiI6IjVjNGIzYTI5M',
  'TgwZjdlNmQ1YzRiM2EyOTE4MGY3ZTZkNWM0YjNhMjkxODBmN2U2ZDVjNGIzYTI5MTgwZjdlN',
  'mQiLCJpZFNpZyI6ImQ0YzNiMmExZjBlOWQ4YzdiNmE1ZjRlM2QyYzFiMGE5ZDRjM2IyYTFmM',
  'GU5ZDhjN2I2YTVmNGUzZDJjMWIwYTkiLCJoYW5kbGUiOiJNYXLDrWEg8J-QpiJ9',
].join('');

describe('toCompactCode', () => {
  it('encodes the sample bundle exactly as before', () => {
    expect(toCompactCode(SAMPLE_BUNDLE)).toBe(SAMPLE_CODE);
  });

  it('drops the avatar and keeps every other field, in order', () => {
    const withoutAvatar = JSON.parse(SAMPLE_BUNDLE);
    delete withoutAvatar.avatar;
    expect(fromCompactCode(SAMPLE_CODE)).toBe(JSON.stringify(withoutAvatar));
  });

  it('returns an empty string when the input is not a JSON object', () => {
    expect(toCompactCode('{not json')).toBe('');
    expect(toCompactCode('null')).toBe('');
  });
});

describe('fromCompactCode', () => {
  it('ignores the spaces and line breaks around a pasted code', () => {
    expect(fromCompactCode(`  ${SAMPLE_CODE}\n`)).toBe(fromCompactCode(SAMPLE_CODE));
  });

  it('returns null without the trino1: prefix, as with a raw JSON bundle', () => {
    expect(fromCompactCode(SAMPLE_BUNDLE)).toBeNull();
    expect(fromCompactCode('')).toBeNull();
  });

  it('returns null when the payload is not base64url', () => {
    expect(fromCompactCode('trino1:@@@')).toBeNull();
  });
});

describe('base64url', () => {
  // UTF-8 first, then the URL-safe alphabet (- and _) without = padding.
  const VECTORS: [string, string][] = [
    ['', ''],
    ['a', 'YQ'],
    ['?>>', 'Pz4-'],
    ['???', 'Pz8_'],
    ['ñ', 'w7E'],
    ['🐦', '8J-Qpg'],
  ];

  it.each(VECTORS)('encodes %j as %j', (text, encoded) => {
    expect(b64urlEncode(text)).toBe(encoded);
  });

  it.each(VECTORS)('decodes %j back from %j', (text, encoded) => {
    expect(b64urlDecode(encoded)).toBe(text);
  });
});

// The trino2: code (T9, W4): base64url of a versioned binary instead of the
// JSON, so it fits a QR code at a glance. SAMPLE_V2 is shaped like what
// `share_bundle` returns, keys in serde_json's sorted order, with made-up keys
// of the real lengths (64-byte signatures). V2_CODE comes from an independent
// Python reference that builds the bytes by hand:
//   [1] [len] handle(utf-8) ikSignPub ikDhPub nostrPub spkId(u32 BE) spkPub spkSig idSig
const SAMPLE_V2_FIELDS = {
  handle: 'María 🐦',
  idSig: 'd4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9'.repeat(4),
  ikDhPub: '8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f',
  ikSignPub: '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29',
  nostrPub: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  opkId: null,
  opkPub: null,
  spkId: 70000,
  spkPub: 'e7a1c2f04d5b6e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f',
  spkSig: '0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(4),
};
const SAMPLE_V2 = JSON.stringify({ avatar: 'data:image/png;base64,iVBORw0KGgo=', ...SAMPLE_V2_FIELDS });

const V2_CODE = [
  'trino2:AQtNYXLDrWEg8J-QpjtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdopj0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4',
  'KF-hssPU5fYHGCk6S1xtfo-QobLD1OX2BxgpOktcbX6PkAABEXDnocLwTVtuj5oLHC0-T1prfI2eDxorPE1eb3qLnA0eLw8eLTxLWml4',
  'h5altMPS4fAPHi08S1ppeIeWpbTD0uHwDx4tPEtaaXiHlqW0w9Lh8A8eLTxLWml4h5altMPS4fDUw7Kh8OnYx7al9OPSwbCp1MOyofDp',
  '2Me2pfTj0sGwqdTDsqHw6djHtqX049LBsKnUw7Kh8OnYx7al9OPSwbCp',
].join('');

/** The bytes of a trino2: code, decoded here with atob, not with the module's own helpers. */
function v2Bytes(code: string): Uint8Array {
  const b64 = code.slice('trino2:'.length).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0));
}

describe('toCompactCodeV2', () => {
  it('encodes the bundle exactly as the reference does', () => {
    expect(toCompactCodeV2(SAMPLE_V2)).toBe(V2_CODE);
  });

  it('gives a code of about 400 characters or less for a usual name', () => {
    expect(V2_CODE.length).toBeLessThanOrEqual(400);
    // Version, length, 11 bytes of "María 🐦", then 260 bytes of keys.
    expect(v2Bytes(V2_CODE)).toHaveLength(2 + 11 + 260);
  });

  it('cuts a name longer than 255 bytes at a whole character', () => {
    const long = JSON.stringify({ ...SAMPLE_V2_FIELDS, handle: '🐦'.repeat(200) });
    const bytes = v2Bytes(toCompactCodeV2(long));
    expect(new TextDecoder().decode(bytes.subarray(2, 2 + bytes[1]!))).toBe('🐦'.repeat(63));
  });

  it('gives an empty string for what is not a whole bundle', () => {
    expect(toCompactCodeV2('{not json')).toBe('');
    expect(toCompactCodeV2('null')).toBe('');
    expect(toCompactCodeV2('[]')).toBe('');
    // The trino1 sample carries 32-byte signatures: not real ones.
    expect(toCompactCodeV2(SAMPLE_BUNDLE)).toBe('');
    const { idSig: _idSig, ...withoutIdSig } = SAMPLE_V2_FIELDS;
    expect(toCompactCodeV2(JSON.stringify(withoutIdSig))).toBe('');
    expect(toCompactCodeV2(JSON.stringify({ ...SAMPLE_V2_FIELDS, ikDhPub: 'zz'.repeat(32) }))).toBe('');
    expect(toCompactCodeV2(JSON.stringify({ ...SAMPLE_V2_FIELDS, spkId: -1 }))).toBe('');
    expect(toCompactCodeV2(JSON.stringify({ ...SAMPLE_V2_FIELDS, spkId: 2 ** 32 }))).toBe('');
    expect(toCompactCodeV2(JSON.stringify({ ...SAMPLE_V2_FIELDS, spkId: 1.5 }))).toBe('');
  });

  it('takes a bundle without a name as one with an empty name', () => {
    const { handle: _handle, ...withoutHandle } = SAMPLE_V2_FIELDS;
    expect(v2Bytes(toCompactCodeV2(JSON.stringify(withoutHandle)))[1]).toBe(0);
  });
});

describe('parseContactCode', () => {
  // P1-13a: only trino3: is added now. The code itself is what goes to the
  // backend (preview_contact, probe_node), with no spaces and its prefix in
  // lower case.
  it('reads a trino3: code, as the backend takes it', () => {
    expect(parseContactCode(V3_VECTOR)).toEqual({ bundleJson: V3_VECTOR, format: 'trino3' });
    const wrapped = ['  TRINO3:' + V3_VECTOR.slice(7, 200), ' ' + V3_VECTOR.slice(200) + ' ', ''].join('\r\n');
    expect(parseContactCode(wrapped)).toEqual({ bundleJson: V3_VECTOR, format: 'trino3' });
  });

  it('reads no code of before: the screen says it is of an earlier version', () => {
    for (const old of [V2_CODE, SAMPLE_CODE, SAMPLE_V2, `  ${SAMPLE_V2}\n`]) {
      expect(parseContactCode(old)).toBeNull();
      expect(isOldContactCode(old)).toBe(true);
    }
  });

  it('rejects what is not a contact code', () => {
    expect(parseContactCode('')).toBeNull();
    expect(parseContactCode('   ')).toBeNull();
    expect(parseContactCode('hola')).toBeNull();
    expect(parseContactCode('trino3:@@@')).toBeNull();
    expect(parseContactCode(V3_VECTOR.slice(0, -4))).toBeNull();
    expect(parseContactCode('{"hola":1}')).toBeNull();
    expect(parseContactCode('[1,2]')).toBeNull();
  });

  // The seam for the invitation links (plan-cambios-11oct §8): another reader
  // joins the list, and the screens that call parseContactCode stay the same.
  it('tries one reader per format, newest first', () => {
    expect(CONTACT_CODE_READERS.map(reader => reader.format)).toEqual(['trino3']);
    expect(CONTACT_CODE_READERS[0]!.read(V3_VECTOR)).toBe(V3_VECTOR);
    expect(CONTACT_CODE_READERS[0]!.read(V2_CODE)).toBeNull();
  });
});

describe('formatFingerprint', () => {
  it('shows a key in capitals, in groups of four', () => {
    expect(formatFingerprint('7f3a.91c2.0b5e.d4a8')).toBe('7F3A 91C2 0B5E D4A8');
    expect(formatFingerprint('70a583c6766daad7')).toBe('70A5 83C6 766D AAD7');
    expect(formatFingerprint('')).toBe('');
  });
});

describe('toShareCode', () => {
  // The code the new screens share and show (W1's last step, W4's share
  // panel): share_bundle gives the trino3: code itself (P1-13a). Only a
  // whole one is shown; a bundle of before is no code to share.
  it('is the trino3: code share_bundle gives', () => {
    expect(toShareCode(V3_VECTOR)).toBe(V3_VECTOR);
    expect(toShareCode(` ${V3_VECTOR}\n`)).toBe(V3_VECTOR);
    expect(toShareCode(V3_VECTOR.slice(0, -1))).toBe('');
    expect(toShareCode(SAMPLE_V2)).toBe('');
    expect(toShareCode('not json')).toBe('');
  });
});

// trino3: (P1-13a). The same fixed vector as contact_code.rs: every field a
// byte pattern, computed apart from both.
const V3_VECTOR = SAMPLE_CODE_V3;

const V3_FIELDS = {
  account: '11'.repeat(32),
  gen: 1,
  seq: 2n,
  listHash: '22'.repeat(16),
  // id 01020304, flags 01 (primary), dev_sign, dev_dh, since (1, 1), d_sig, dh_sig.
  entry:
    '0102030401' + '33'.repeat(32) + '44'.repeat(32) + '00000001' + '0000000000000001' + '55'.repeat(64) + '66'.repeat(64),
  // id 0a0b0c0d, key, signature.
  spk: '0a0b0c0d' + '77'.repeat(32) + '88'.repeat(64),
  r: '99'.repeat(32),
  rDh: 'aa'.repeat(32),
};

describe('trino3:', () => {
  it('encodes and decodes the fixed vector', () => {
    expect(V3_LENGTH).toBe(434);
    expect(V3_VECTOR.length).toBe(7 + 579);
    expect(encodeCodeV3(V3_FIELDS)).toBe(V3_VECTOR);
    expect(decodeCodeV3(V3_VECTOR)).toEqual(V3_FIELDS);
  });

  it('reads a code a chat app wrapped, with its prefix in capitals', () => {
    const wrapped = ['  TRINO3:' + V3_VECTOR.slice(7, 200), V3_VECTOR.slice(200, 400), ' ' + V3_VECTOR.slice(400) + ' '];
    expect(decodeCodeV3(wrapped.join('\n'))).toEqual(V3_FIELDS);
    expect(decodeCodeV3(wrapped.join('\r\n'))).toEqual(V3_FIELDS);
  });

  it('refuses another length, another version, padding and what is not base64url', () => {
    const b64 = V3_VECTOR.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0));
    const text = (b: Uint8Array) =>
      'trino3:' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(text(bytes)).toBe(V3_VECTOR);
    expect(decodeCodeV3(text(bytes.subarray(0, V3_LENGTH - 1)))).toBeNull();
    expect(decodeCodeV3(text(Uint8Array.from([...bytes, 0])))).toBeNull();
    const v2 = Uint8Array.from(bytes);
    v2[0] = 2;
    expect(decodeCodeV3(text(v2))).toBeNull();
    expect(decodeCodeV3(V3_VECTOR + '=')).toBeNull();
    expect(decodeCodeV3('trino3:###')).toBeNull();
    expect(decodeCodeV3(V3_VECTOR.slice(7))).toBeNull();
    expect(decodeCodeV3('')).toBeNull();
  });

  it('writes nothing for a field that does not fit', () => {
    expect(encodeCodeV3({ ...V3_FIELDS, account: 'zz' })).toBe('');
    expect(encodeCodeV3({ ...V3_FIELDS, entry: V3_FIELDS.entry.slice(2) })).toBe('');
    expect(encodeCodeV3({ ...V3_FIELDS, gen: 2 ** 32 })).toBe('');
    expect(encodeCodeV3({ ...V3_FIELDS, seq: 2n ** 64n })).toBe('');
    expect(encodeCodeV3({ ...V3_FIELDS, seq: -1n })).toBe('');
  });

  it('tells the codes of before apart', () => {
    expect(isOldContactCode(SAMPLE_BUNDLE)).toBe(true);
    expect(isOldContactCode(`  ${SAMPLE_BUNDLE}\n`)).toBe(true);
    expect(isOldContactCode(SAMPLE_CODE)).toBe(true);
    expect(isOldContactCode(V2_CODE)).toBe(true);
    expect(isOldContactCode('TRINO2:AQNhbmE')).toBe(true);
    expect(isOldContactCode(V3_VECTOR)).toBe(false);
    expect(isOldContactCode('hola')).toBe(false);
    expect(isOldContactCode('{"a":1}')).toBe(false);
    expect(isOldContactCode('trino1:')).toBe(false);
  });
});
