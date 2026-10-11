import { describe, expect, it } from 'vitest';
import {
  CONTACT_CODE_READERS,
  b64urlDecode,
  b64urlEncode,
  formatFingerprint,
  fromCompactCode,
  parseContactCode,
  toCompactCode,
  toCompactCodeV2,
  toShareCode,
} from './contact-code';

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
/** What `share_bundle` would give without the avatar: the bundle JSON a trino2: code carries. */
const SAMPLE_V2_NO_AVATAR = JSON.stringify(SAMPLE_V2_FIELDS);

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
function v2Code(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return 'trino2:' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    const parsed = parseContactCode(toCompactCodeV2(long));
    expect(JSON.parse(parsed!.bundleJson).handle).toBe('🐦'.repeat(63));
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
    const parsed = parseContactCode(toCompactCodeV2(JSON.stringify(withoutHandle)));
    expect(JSON.parse(parsed!.bundleJson).handle).toBe('');
  });
});

describe('parseContactCode', () => {
  it('reads a trino2: code back into the bundle share_bundle gave, without the avatar', () => {
    expect(parseContactCode(V2_CODE)).toEqual({ bundleJson: SAMPLE_V2_NO_AVATAR, format: 'trino2' });
  });

  it('still reads trino1: codes and raw JSON bundles', () => {
    expect(parseContactCode(SAMPLE_CODE)).toEqual({ bundleJson: fromCompactCode(SAMPLE_CODE), format: 'trino1' });
    expect(parseContactCode(`  ${SAMPLE_V2}\n`)).toEqual({ bundleJson: SAMPLE_V2, format: 'json' });
  });

  it('ignores spaces and line breaks inside a pasted code, and the case of its prefix', () => {
    const wrapped = V2_CODE.slice(0, 60) + '\n  ' + V2_CODE.slice(60, 200) + ' \r\n' + V2_CODE.slice(200);
    expect(parseContactCode(wrapped)?.bundleJson).toBe(SAMPLE_V2_NO_AVATAR);
    expect(parseContactCode('TRINO2:' + V2_CODE.slice(7))?.format).toBe('trino2');
  });

  it('rejects a version it does not know', () => {
    const bytes = v2Bytes(V2_CODE);
    bytes[0] = 2;
    expect(parseContactCode(v2Code(bytes))).toBeNull();
    bytes[0] = 0;
    expect(parseContactCode(v2Code(bytes))).toBeNull();
  });

  it('rejects every truncated code', () => {
    const cut = Array.from({ length: V2_CODE.length - 'trino2:'.length }, (_, i) => V2_CODE.slice(0, 7 + i))
      .filter(code => parseContactCode(code) !== null);
    expect(cut).toEqual([]);
  });

  it('rejects corrupt codes: other characters, extra bytes, a name that is not UTF-8', () => {
    expect(parseContactCode('trino2:AQtN@XLDrWEg')).toBeNull();
    expect(parseContactCode(V2_CODE.slice(0, 40) + '+' + V2_CODE.slice(41))).toBeNull();
    expect(parseContactCode(v2Code(Uint8Array.from([...v2Bytes(V2_CODE), 0, 0, 0])))).toBeNull();
    const bytes = v2Bytes(V2_CODE);
    bytes[2] = 0xff;
    expect(parseContactCode(v2Code(bytes))).toBeNull();
    const longer = v2Bytes(V2_CODE);
    longer[1] = 200;
    expect(parseContactCode(v2Code(longer))).toBeNull();
  });

  it('rejects what is not a contact code', () => {
    expect(parseContactCode('')).toBeNull();
    expect(parseContactCode('   ')).toBeNull();
    expect(parseContactCode('hola')).toBeNull();
    expect(parseContactCode('trino1:@@@')).toBeNull();
    // trino1: and JSON that decode, but to no bundle.
    expect(parseContactCode('trino1:YQ')).toBeNull();
    expect(parseContactCode('{"hola":1}')).toBeNull();
    expect(parseContactCode('[1,2]')).toBeNull();
  });

  // The seam for the invitation links (plan-cambios-11oct §8): another reader
  // joins the list, and the screens that call parseContactCode stay the same.
  it('tries one reader per format, newest first', () => {
    expect(CONTACT_CODE_READERS.map(reader => reader.format)).toEqual(['trino2', 'trino1', 'json']);
    expect(CONTACT_CODE_READERS[0]!.read(V2_CODE)).toBe(SAMPLE_V2_NO_AVATAR);
    expect(CONTACT_CODE_READERS[0]!.read(SAMPLE_CODE)).toBeNull();
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
  // panel). Only trino2: is shared; trino1: and JSON are still read.
  it('is the trino2: code', () => {
    expect(toShareCode(SAMPLE_V2)).toBe(V2_CODE);
    expect(toShareCode('not json')).toBe('');
  });
});
