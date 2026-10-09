import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, fromCompactCode, toCompactCode } from './contact-code';

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
