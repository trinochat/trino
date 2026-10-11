import { describe, expect, it } from 'vitest';
import { THUMB_MAX_CHARS } from '../../../lib/media';
import { STICKER_INLINE_MAX, stickerThumb } from './sticker-limits';

/**
 * What the relays take: the whole `["EVENT", …]` message, 64 KB at most
 * (trino-rediseno.md:154). 64,000 leaves room for relays that count in
 * thousands; a bigger event is dropped without a word.
 */
const RELAY_LIMIT = 64_000;

const PREFIX = 'data:image/webp;base64,';
/** An inline picture of exactly `chars` characters. */
const thumbOf = (chars: number) => PREFIX + 'A'.repeat(chars - PREFIX.length);
const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The relay message that carries a file with this inline picture, at its
 * largest: the file envelope of trino-core (envelope.rs, group.rs FileRef)
 * with every field long, a group id and the profile mark of K12; AES-GCM adds
 * a 16-byte tag and the ciphertext travels in hex, twice its size
 * (ratchet.rs); then the wire payload with a handshake (commands.rs
 * WirePayload) inside a signed Nostr event.
 */
function relayMessageBytes(thumb: string): number {
  const envelope = JSON.stringify({
    ty: 'file',
    file: {
      url: `https://${'b'.repeat(40)}/${'f'.repeat(64)}.webp`,
      key: 'k'.repeat(64),
      sha256: 's'.repeat(64),
      mime: 'image/webp',
      name: `sticker::${'i'.repeat(64)}.webp`,
      size: 5 * 1024 * 1024,
      thumb,
    },
    gid: 'g'.repeat(64),
    prof: { v: 1, have: Number.MAX_SAFE_INTEGER },
  });
  const payload = JSON.stringify({
    header: { dhPub: 'd'.repeat(64), pn: 4_294_967_295, n: 4_294_967_295 },
    nonce: 'n'.repeat(24),
    ciphertext: 'c'.repeat((bytes(envelope) + 16) * 2),
    handshake: { ikDhPub: 'h'.repeat(64), ekPub: 'e'.repeat(64), spkId: 4_294_967_295, opkId: 4_294_967_295 },
  });
  const event = {
    id: 'i'.repeat(64),
    pubkey: 'p'.repeat(64),
    created_at: 4_102_444_800,
    kind: 30_078,
    tags: [['p', 'q'.repeat(64)]],
    content: payload,
    sig: 'z'.repeat(128),
  };
  return bytes(JSON.stringify(['EVENT', event]));
}

describe('STICKER_INLINE_MAX', () => {
  it('keeps the message of a sticker with its inline picture under what the relays take', () => {
    expect(relayMessageBytes(thumbOf(STICKER_INLINE_MAX))).toBeLessThanOrEqual(RELAY_LIMIT);
  });

  // App.tsx sent pictures of up to 60,000 characters inline: twice what fits,
  // so those stickers never arrived (trino-rediseno.md:308).
  it('is why a sticker under the old ceiling of 60,000 characters never arrived', () => {
    expect(relayMessageBytes(thumbOf(59_999))).toBeGreaterThan(RELAY_LIMIT);
  });

  it('wastes no more than a seventh of the room', () => {
    expect(relayMessageBytes(thumbOf(STICKER_INLINE_MAX))).toBeGreaterThanOrEqual(RELAY_LIMIT * (6 / 7));
  });

  it('is the ceiling of the previews of the pictures you send too', () => {
    expect(STICKER_INLINE_MAX).toBe(THUMB_MAX_CHARS);
  });
});

describe('stickerThumb', () => {
  it('sends the picture of a small sticker inline', () => {
    const small = thumbOf(STICKER_INLINE_MAX);
    expect(stickerThumb({ data_url: small })).toBe(small);
  });

  it('leaves out a bigger one: the contact downloads it from the file server instead', () => {
    expect(stickerThumb({ data_url: thumbOf(STICKER_INLINE_MAX + 1) })).toBeNull();
  });

  it('leaves out what the backend would refuse as an inline picture', () => {
    expect(stickerThumb({ data_url: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeNull();
    expect(stickerThumb({ data_url: 'https://example.com/sticker.png' })).toBeNull();
  });
});
