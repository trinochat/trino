export interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  version?: string;
  url?: string;
}

export interface AnnouncementFeed {
  announcements: Announcement[];
  /**
   * - `verified`: signature checked against the PINNED signer key.
   * - `bundled`: no signed feed published/reachable — normal, compile-time copy.
   * - `untrusted`: a feed WAS served but failed verification (bad signature,
   *   wrong signer, or a rollback). That is an attack indicator, not a missing
   *   file, and the UI must say so instead of silently showing stale content.
   */
  source: 'verified' | 'bundled' | 'untrusted';
  signerFingerprint?: string;
}

interface SignedAnnouncementEnvelope {
  payload: string;
  signature: string;
}

const MAX_FEED_BYTES = 512_000;
const MAX_PUBLIC_KEY_BYTES = 128_000;
const MAX_ANNOUNCEMENTS = 50;

/**
 * Fingerprint of the announcement signing key — the ONLY trust anchor.
 *
 * Verifying against a key fetched from the same origin as the feed proves
 * nothing: whoever serves the feed can serve a matching key. So until this is
 * set to the real signer's fingerprint (uppercase hex, no spaces), the client
 * refuses to call any feed "verified" and just ships the bundled copy.
 *
 * Set it to the fingerprint of the key used by scripts/sign-announcement.mjs.
 */
const PINNED_SIGNER_FINGERPRINT: string =
  '4DE8E4BC5872E37566FA4114A62EE5607F666A6B';

/** Highest signed `seq` ever accepted — blocks rollback to an older feed. */
const SEQ_STORAGE_KEY = 'trino:announcements:minSeq';

export const BUNDLED_ANNOUNCEMENTS: Announcement[] = [
  {
    id: '2026-07-17-mobile-themes',
    title: 'Trino móvil estrena una interfaz más familiar',
    body:
      'La lista de chats, el compositor y las llamadas usan patrones móviles conocidos. También se añadieron estilos Trino, Corporativo y Simple con color de acento configurable.',
    publishedAt: '2026-07-17T09:30:00-05:00',
    version: '0.1.0',
  },
];

const bundled = (source: AnnouncementFeed['source']): AnnouncementFeed => ({
  announcements: BUNDLED_ANNOUNCEMENTS,
  source,
});

export async function loadAnnouncementFeed(): Promise<AnnouncementFeed> {
  // No pinned signer → we cannot prove anything about a fetched key, so we must
  // not claim "verified". Ship the compile-time feed (trusted via the installer).
  if (!PINNED_SIGNER_FINGERPRINT) return bundled('bundled');

  // Stage 1: fetch. A missing/unreachable feed is normal, not an attack.
  let envelopeText: string;
  let publicKeyArmored: string;
  try {
    const [envelopeResponse, publicKeyResponse] = await Promise.all([
      fetch('/updates/feed.json', { cache: 'no-store' }),
      fetch('/updates/public-key.asc', { cache: 'force-cache' }),
    ]);
    if (!envelopeResponse.ok || !publicKeyResponse.ok) {
      throw new Error('signed announcement feed is not configured');
    }
    envelopeText = await readBoundedText(envelopeResponse, MAX_FEED_BYTES);
    publicKeyArmored = await readBoundedText(
      publicKeyResponse,
      MAX_PUBLIC_KEY_BYTES,
    );
  } catch (error) {
    console.warn('announcement feed unavailable, using bundled', error);
    return bundled('bundled');
  }

  // Stage 2: verify. Anything failing HERE means a feed was served but did not
  // authenticate — surface it as untrusted rather than silently downgrading.
  try {
    const envelope = JSON.parse(envelopeText) as SignedAnnouncementEnvelope;
    if (
      typeof envelope.payload !== 'string' ||
      typeof envelope.signature !== 'string'
    ) {
      throw new Error('invalid signed announcement envelope');
    }

    const openpgp = await import('openpgp');
    const verificationKey = await openpgp.readKey({
      armoredKey: publicKeyArmored,
    });

    // THE trust check: the served key must be the pinned signer. Without this
    // the whole scheme is circular — whoever serves the feed serves the key.
    const fingerprint = verificationKey.getFingerprint().toUpperCase();
    if (fingerprint !== PINNED_SIGNER_FINGERPRINT.toUpperCase()) {
      throw new Error(`unexpected announcement signer: ${fingerprint}`);
    }

    const message = await openpgp.createMessage({ text: envelope.payload });
    const signature = await openpgp.readSignature({
      armoredSignature: envelope.signature,
    });
    const result = await openpgp.verify({
      message,
      signature,
      verificationKeys: verificationKey,
      format: 'utf8',
    });
    const firstSignature = result.signatures[0];
    if (!firstSignature) throw new Error('announcement signature is missing');
    await firstSignature.verified;

    // Signature is good — now refuse an older feed being replayed at us.
    const announcements = parseAnnouncements(envelope.payload);
    commitFeedSequence(envelope.payload);

    return { announcements, source: 'verified', signerFingerprint: fingerprint };
  } catch (error) {
    console.error('announcement feed FAILED verification', error);
    return bundled('untrusted');
  }
}

/**
 * The signed payload must carry a monotonically increasing `seq`. Without it a
 * valid-but-old feed can be replayed forever to suppress a security notice.
 */
function commitFeedSequence(payload: string): void {
  const parsed = JSON.parse(payload) as { seq?: unknown };
  const seq = parsed.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('signed feed is missing a valid seq');
  }
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(SEQ_STORAGE_KEY) || '0') || 0;
  } catch {
    /* storage unavailable — fail open on read, still enforce within session */
  }
  if (seq < seen) {
    throw new Error(`announcement rollback: seq ${seq} < last accepted ${seen}`);
  }
  if (seq > seen) {
    try {
      localStorage.setItem(SEQ_STORAGE_KEY, String(seq));
    } catch {
      /* ignore */
    }
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (declaredLength > maxBytes) throw new Error('announcement resource is too large');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error('announcement resource is too large');
  }
  return text;
}

function parseAnnouncements(payload: string): Announcement[] {
  if (new TextEncoder().encode(payload).byteLength > MAX_FEED_BYTES) {
    throw new Error('announcement payload is too large');
  }
  const parsed = JSON.parse(payload) as { announcements?: unknown };
  if (!Array.isArray(parsed.announcements)) {
    throw new Error('announcement list is missing');
  }
  if (parsed.announcements.length > MAX_ANNOUNCEMENTS) {
    throw new Error('too many announcements');
  }
  return parsed.announcements.map((item) => validateAnnouncement(item));
}

function validateAnnouncement(value: unknown): Announcement {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid announcement');
  }
  const item = value as Record<string, unknown>;
  const id = boundedString(item.id, 'id', 96);
  const title = boundedString(item.title, 'title', 120);
  const body = boundedString(item.body, 'body', 5_000);
  const publishedAt = boundedString(item.publishedAt, 'publishedAt', 64);
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new Error('invalid announcement date');
  }
  const version =
    item.version === undefined
      ? undefined
      : boundedString(item.version, 'version', 48);
  const url =
    item.url === undefined ? undefined : boundedString(item.url, 'url', 2_048);
  if (url && new URL(url).protocol !== 'https:') {
    throw new Error('announcement links must use HTTPS');
  }
  return { id, title, body, publishedAt, version, url };
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') throw new Error(`invalid ${field}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`invalid ${field}`);
  }
  return normalized;
}
