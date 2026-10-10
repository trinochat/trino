import { describe, expect, it } from 'vitest';
import { b64urlEncode } from './contact-code';
import { decodeBody, encodeMeta, encodeReply } from './message-body';

// Golden values: what App.tsx produced at d8746ff for these inputs, computed by
// running that code. The body is a wire format in practice: messages people
// already sent, and peers on older versions, carry exactly these bytes. A
// failure here means old messages would stop decoding, or new ones would read
// differently on the other side.

/** 120 characters with accents and an emoji: longer than the 90 a quote keeps. */
const LONG_PREVIEW =
  'Una vista previa larga con tildes, eñes y un pájaro 🐦 que pasa de noventa caracteres para ver el corte exacto del texto';
/** `LONG_PREVIEW.slice(0, 90)`. */
const CUT_PREVIEW = 'Una vista previa larga con tildes, eñes y un pájaro 🐦 que pasa de noventa caracteres para';

const REPLY_BODY = '\x01R\x01QW5h\x01QSBsYXMgNiDwn5Cm\x01¿Nos vemos?';
const LONG_REPLY_BODY =
  '\x01R\x01TWFyw61hIEpvc8Op\x01VW5hIHZpc3RhIHByZXZpYSBsYXJnYSBjb24gdGlsZGVzLCBlw7FlcyB5IHVuIHDDoWphcm8g8J+QpiBxdWUgcGFzYSBkZSBub3ZlbnRhIGNhcmFjdGVyZXMgcGFyYQ==\x01ok';
const TTL_BODY = 'trm1:eyJ0IjoiYWRpw7NzIiwiZCI6MzB9';
const TTL_REPLY_BODY =
  'trm1:eyJ0IjoidmEiLCJkIjozNjAwLCJyIjp7ImF1dGhvciI6Ik1hcsOtYSDwn5CmIiwicHJldmlldyI6IlVuYSB2aXN0YSBwcmV2aWEgbGFyZ2EgY29uIHRpbGRlcywgZcOxZXMgeSB1biBww6FqYXJvIPCfkKYgcXVlIHBhc2EgZGUgbm92ZW50YSBjYXJhY3RlcmVzIHBhcmEifX0';

describe('encodeMeta', () => {
  it('sends a plain text as it is', () => {
    expect(encodeMeta('hola', {})).toBe('hola');
  });

  it('marks a reply with \\x01R\\x01, base64 of the author and the quote, then the text', () => {
    expect(encodeMeta('¿Nos vemos?', { reply: { author: 'Ana', preview: 'A las 6 🐦' } })).toBe(REPLY_BODY);
  });

  it('keeps the first 90 UTF-16 units of a quote', () => {
    expect(LONG_PREVIEW.slice(0, 90)).toBe(CUT_PREVIEW);
    expect(encodeMeta('ok', { reply: { author: 'María José', preview: LONG_PREVIEW } })).toBe(LONG_REPLY_BODY);
  });

  it('wraps a disappearing message in trm1: and base64url JSON', () => {
    expect(encodeMeta('adiós', { ttl: 30 })).toBe(TTL_BODY);
  });

  it('puts the reply inside the trm1: envelope when the message disappears', () => {
    expect(encodeMeta('va', { ttl: 3600, reply: { author: 'María 🐦', preview: LONG_PREVIEW } })).toBe(TTL_REPLY_BODY);
  });

  it('treats a ttl of 0 as no ttl', () => {
    expect(encodeMeta('hola', { ttl: 0 })).toBe('hola');
    expect(encodeMeta('¿Nos vemos?', { ttl: 0, reply: { author: 'Ana', preview: 'A las 6 🐦' } })).toBe(REPLY_BODY);
  });
});

describe('encodeReply', () => {
  it('is the reply marker format on its own', () => {
    expect(encodeReply('Ana', 'hola', 'texto conmigo')).toBe('\x01R\x01QW5h\x01aG9sYQ==\x01texto conmigo');
  });
});

describe('decodeBody', () => {
  it('reads every format it writes back', () => {
    expect(decodeBody('hola')).toEqual({ text: 'hola' });
    expect(decodeBody(REPLY_BODY)).toEqual({ reply: { author: 'Ana', preview: 'A las 6 🐦' }, text: '¿Nos vemos?' });
    expect(decodeBody(LONG_REPLY_BODY)).toEqual({ reply: { author: 'María José', preview: CUT_PREVIEW }, text: 'ok' });
    expect(decodeBody(TTL_BODY)).toEqual({ text: 'adiós', ttl: 30 });
    expect(decodeBody(TTL_REPLY_BODY)).toEqual({
      text: 'va',
      reply: { author: 'María 🐦', preview: CUT_PREVIEW },
      ttl: 3600,
    });
  });

  it('shows a trm1: body that is not base64url JSON as plain text', () => {
    expect(decodeBody('trm1:!!!')).toEqual({ text: 'trm1:!!!' });
  });

  it('turns the trm1: text into a string and ignores a ttl that is not a number', () => {
    expect(decodeBody('trm1:' + b64urlEncode(JSON.stringify({ t: 5, d: '30' })))).toEqual({ text: '5' });
    expect(decodeBody('trm1:' + b64urlEncode(JSON.stringify({ r: { author: 'A', preview: 'P' } })))).toEqual({
      text: '',
      reply: { author: 'A', preview: 'P' },
    });
  });

  it('shows a reply marker without its three parts, or with bad base64, as plain text', () => {
    expect(decodeBody('\x01R\x01QQ==\x01only')).toEqual({ text: '\x01R\x01QQ==\x01only' });
    expect(decodeBody('\x01R\x01***\x01UA==\x01text')).toEqual({ text: '\x01R\x01***\x01UA==\x01text' });
  });

  it('keeps \\x01 inside the text of a reply, and in a plain text', () => {
    expect(decodeBody(encodeReply('A', 'P', 'uno\x01dos'))).toEqual({
      reply: { author: 'A', preview: 'P' },
      text: 'uno\x01dos',
    });
    expect(decodeBody('hola \x01 mundo')).toEqual({ text: 'hola \x01 mundo' });
  });
});
