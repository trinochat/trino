/**
 * The two boxes of the first step and the record they leave on this device
 * (the parent's addendum to plan-cambios-11oct, David, 11 Oct 2026):
 *
 * - "Tengo 18 años o más": Trino is for people of 18 or more. A box, with no
 *   birth date and no document (reports/Marco legal de Trino Chat.md,
 *   action 10).
 * - "Leí y acepto cómo Trino trata mis datos", with a link to the public
 *   document: the authorization of Ley 1581, arts. 9 and 10, which has to be
 *   prior, express and informed, and provable.
 *
 * Both start unticked and both are required. Once the identity exists, the
 * record keeps the date, the version of each text accepted and the
 * identity's public key, as the public document promises ("guardará en tu
 * computador la fecha y la versión que aceptaste").
 */
import type { Lang } from '../../../lib/i18n';

export const MINIMUM_AGE = 18;
/** The version of the age statement (`onb.ageLabel`). Raise it when its words change. */
export const AGE_STATEMENT_VERSION = 1;
/**
 * The version of the public document "Cómo funciona Trino y cómo trata tus
 * datos" that the box accepts: its last line says "Versión 1". Raise it with
 * each new version, so a new account records the one it accepted.
 */
export const PRIVACY_POLICY_VERSION = 1;
/** Where that document is published, opened in the system browser. */
export const PRIVACY_POLICY_URL = 'https://trinochat.org/privacidad/';

/** One record per device: the identity on it. A new identity replaces it. */
export const CONSENT_STORAGE_KEY = 'trino.consent';

/** The part of `Storage` the record uses; `window.localStorage` fits. */
export type ConsentStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ConsentRecord {
  /** The shape of this record. */
  format: 1;
  /** When the identity was created with both boxes ticked: ISO 8601, UTC. */
  acceptedAt: string;
  /** Who accepted: the new identity's public key (`nostr_pub`, hex). */
  publicKey: string;
  /** The language the boxes and the link were shown in. */
  lang: Lang;
  /** "Tengo 18 años o más", ticked: the age it states and the version of its words. */
  age: { minimum: number; version: number };
  /** "Leí y acepto cómo Trino trata mis datos", ticked: the document's version and where it is. */
  privacyPolicy: { version: number; url: string };
}

export function consentRecord({ publicKey, lang, at }: { publicKey: string; lang: Lang; at: Date }): ConsentRecord {
  return {
    format: 1,
    acceptedAt: at.toISOString(),
    publicKey,
    lang,
    age: { minimum: MINIMUM_AGE, version: AGE_STATEMENT_VERSION },
    privacyPolicy: { version: PRIVACY_POLICY_VERSION, url: PRIVACY_POLICY_URL },
  };
}

/** Keeps the record on this device; false when storage refused it. */
export function saveConsentRecord(storage: ConsentStorage, record: ConsentRecord): boolean {
  try {
    storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The record on this device, or null when there is none or it does not say what was accepted. */
export function loadConsentRecord(storage: ConsentStorage): ConsentRecord | null {
  let text: string | null;
  try {
    text = storage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isConsentRecord(value) ? value : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isVersion = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

function isConsentRecord(value: unknown): value is ConsentRecord {
  if (!isObject(value) || value.format !== 1) return false;
  const { acceptedAt, publicKey, lang, age, privacyPolicy } = value;
  return (
    typeof acceptedAt === 'string' &&
    !Number.isNaN(Date.parse(acceptedAt)) &&
    typeof publicKey === 'string' &&
    publicKey !== '' &&
    typeof lang === 'string' &&
    isObject(age) &&
    typeof age.minimum === 'number' &&
    isVersion(age.version) &&
    isObject(privacyPolicy) &&
    isVersion(privacyPolicy.version) &&
    typeof privacyPolicy.url === 'string'
  );
}
