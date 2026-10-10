/**
 * The body of a text message as it travels: plain text, a reply marker, or the
 * `trm1:` envelope of a disappearing message. Moved out of App.tsx unchanged;
 * message-body.test.ts pins the format with golden values, because messages
 * already sent and older versions depend on these exact bytes.
 */
import { b64urlDecode, b64urlEncode } from './contact-code';

// New ASCII-safe metadata envelope for TTL (+optional reply):
// "trm1:" + base64url(JSON{t:text, d:ttlSec, r:{author,preview}}).
export const META_PREFIX = 'trm1:';

export function encodeMeta(
  text: string,
  opts: { reply?: { author: string; preview: string }; ttl?: number },
): string {
  if (opts.ttl) {
    const obj: { t: string; d: number; r?: { author: string; preview: string } } = {
      t: text,
      d: opts.ttl,
    };
    if (opts.reply) obj.r = { author: opts.reply.author, preview: opts.reply.preview.slice(0, 90) };
    return META_PREFIX + b64urlEncode(JSON.stringify(obj));
  }
  if (opts.reply) return encodeReply(opts.reply.author, opts.reply.preview, text);
  return text;
}

// Reply is encoded inside the message body (frontend-only, no wire change):
// \x01R\x01<b64 author>\x01<b64 preview>\x01<actual text>
export const REPLY_MARK = '\x01R\x01';
export function encodeReply(author: string, preview: string, text: string): string {
  const a = btoa(unescape(encodeURIComponent(author)));
  const p = btoa(unescape(encodeURIComponent(preview.slice(0, 90))));
  return REPLY_MARK + a + '\x01' + p + '\x01' + text;
}
export function decodeBody(body: string): {
  reply?: { author: string; preview: string };
  text: string;
  ttl?: number;
} {
  if (body.startsWith(META_PREFIX)) {
    try {
      const obj = JSON.parse(b64urlDecode(body.slice(META_PREFIX.length)));
      return {
        text: String(obj.t ?? ''),
        reply: obj.r ? { author: String(obj.r.author), preview: String(obj.r.preview) } : undefined,
        ttl: typeof obj.d === 'number' ? obj.d : undefined,
      };
    } catch {
      return { text: body };
    }
  }
  if (!body.startsWith(REPLY_MARK)) return { text: body };
  const parts = body.slice(REPLY_MARK.length).split('\x01');
  if (parts.length < 3) return { text: body };
  try {
    return {
      reply: {
        author: decodeURIComponent(escape(atob(parts[0]!))),
        preview: decodeURIComponent(escape(atob(parts[1]!))),
      },
      text: parts.slice(2).join('\x01'),
    };
  } catch {
    return { text: body };
  }
}
