import { describe, expect, it } from 'vitest';
import {
  AGE_STATEMENT_VERSION,
  CONSENT_STORAGE_KEY,
  MINIMUM_AGE,
  PRIVACY_POLICY_URL,
  PRIVACY_POLICY_VERSION,
  consentRecord,
  loadConsentRecord,
  saveConsentRecord,
  type ConsentRecord,
  type ConsentStorage,
} from './consent';

/** A storage stand-in that keeps what it is given, or refuses every write. */
function memoryStorage({ refuseWrites = false } = {}) {
  const data = new Map<string, string>();
  const storage: ConsentStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      if (refuseWrites) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
  };
  return { storage, data };
}

const PUBLIC_KEY = 'a'.repeat(64);
const AT = new Date(Date.UTC(2026, 9, 11, 14, 3, 0));

describe('consentRecord', () => {
  // The parent's addendum (David, 11 Oct 2026): Trino is for people of 18 or
  // more, and the data authorization of Ley 1581 must be provable. The record
  // on this device holds the date, the version of each text accepted and the
  // public key of the identity that accepted them.
  it('holds the date, the version of each text and the public key', () => {
    expect(consentRecord({ publicKey: PUBLIC_KEY, lang: 'es', at: AT })).toEqual({
      format: 1,
      acceptedAt: '2026-10-11T14:03:00.000Z',
      publicKey: PUBLIC_KEY,
      lang: 'es',
      age: { minimum: 18, version: AGE_STATEMENT_VERSION },
      privacyPolicy: { version: PRIVACY_POLICY_VERSION, url: PRIVACY_POLICY_URL },
    });
  });

  it('points at the public document and its first version, for people of 18 or more', () => {
    expect(MINIMUM_AGE).toBe(18);
    expect(PRIVACY_POLICY_URL).toBe('https://trinochat.org/privacidad/');
    expect(PRIVACY_POLICY_VERSION).toBe(1);
    expect(AGE_STATEMENT_VERSION).toBe(1);
  });
});

describe('saveConsentRecord and loadConsentRecord', () => {
  const record: ConsentRecord = consentRecord({ publicKey: PUBLIC_KEY, lang: 'pt', at: AT });

  it('keep the record on this device under its own key', () => {
    const { storage, data } = memoryStorage();
    expect(saveConsentRecord(storage, record)).toBe(true);
    expect([...data.keys()]).toEqual([CONSENT_STORAGE_KEY]);
    expect(CONSENT_STORAGE_KEY).toBe('trino.consent');
    expect(loadConsentRecord(storage)).toEqual(record);
  });

  it('say so when storage refuses the record, without throwing', () => {
    const { storage } = memoryStorage({ refuseWrites: true });
    expect(saveConsentRecord(storage, record)).toBe(false);
  });

  // A record without the versions proves nothing about what was accepted.
  it('read back no record that lacks a version, the key or the date', () => {
    const { storage, data } = memoryStorage();
    const broken = (change: Record<string, unknown>) => JSON.stringify({ ...record, ...change });
    for (const text of [
      broken({ privacyPolicy: { url: PRIVACY_POLICY_URL } }),
      broken({ age: { minimum: 18 } }),
      broken({ publicKey: '' }),
      broken({ acceptedAt: 'yesterday' }),
      broken({ format: 2 }),
      'not json',
      '[]',
    ]) {
      data.set(CONSENT_STORAGE_KEY, text);
      expect(loadConsentRecord(storage), text).toBeNull();
    }
  });

  it('read nothing when there is no record or storage cannot be read', () => {
    expect(loadConsentRecord(memoryStorage().storage)).toBeNull();
    const unreadable: ConsentStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    expect(loadConsentRecord(unreadable)).toBeNull();
  });
});
