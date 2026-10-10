import { describe, expect, it } from 'vitest';
import vectors from '../../assets/sas/vectors.json';
import {
  SAS_ALPHABET_SIZE,
  SAS_LENGTH,
  SasInputError,
  callSas,
  callSasDigest,
  contactSas,
  contactSasDigest,
  sasIndices,
  type CallSasInput,
  type ContactSasInput,
} from './sas';

/**
 * SAS v2 (docs/sas-v2.md, plan §6). The golden vectors come from
 * scripts/sas_vectors.py, an independent implementation in Python hashlib.
 */

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function randomHex64(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function randomCallId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function randomCall(): CallSasInput {
  return { callId: randomCallId(), idA: randomHex64(), idB: randomHex64(), dtlsA: randomHex64(), dtlsB: randomHex64() };
}

/** The last hex digit changed to another one. */
function flipLast(value: string): string {
  const last = value[value.length - 1];
  return value.slice(0, -1) + (last === '0' ? '1' : '0');
}

const callInput = ({ callId, idA, idB, dtlsA, dtlsB }: CallSasInput): CallSasInput => ({ callId, idA, idB, dtlsA, dtlsB });
const contactInput = ({ idA, idB }: ContactSasInput): ContactSasInput => ({ idA, idB });
const base = callInput(vectors.call[0]!);

describe('golden vectors (scripts/sas_vectors.py)', () => {
  it('has vectors for both derivations', () => {
    expect(vectors.version).toBe(2);
    expect(vectors.call.length).toBeGreaterThanOrEqual(10);
    expect(vectors.contact.length).toBeGreaterThanOrEqual(5);
  });

  it.each(vectors.call.map(v => [v.name, v] as const))('call: %s', async (_name, v) => {
    expect(hex(await callSasDigest(callInput(v)))).toBe(v.digest);
    expect(await callSas(callInput(v))).toEqual(v.indices);
  });

  it.each(vectors.contact.map(v => [v.name, v] as const))('contact: %s', async (_name, v) => {
    expect(hex(await contactSasDigest(contactInput(v)))).toBe(v.digest);
    expect(await contactSas(contactInput(v))).toEqual(v.indices);
  });

  it.each(vectors.invalid.call.map(v => [v.name, v] as const))('rejects call input: %s', async (_name, v) => {
    await expect(callSas(callInput(v))).rejects.toBeInstanceOf(SasInputError);
  });

  it.each(vectors.invalid.contact.map(v => [v.name, v] as const))('rejects contact input: %s', async (_name, v) => {
    await expect(contactSas(contactInput(v))).rejects.toBeInstanceOf(SasInputError);
  });
});

describe('order independence', () => {
  it('gives both sides of a call the same symbols, whatever the order', async () => {
    for (let round = 0; round < 25; round += 1) {
      const x = randomCall();
      const expected = await callSas(x);
      expect(await callSas({ ...x, idA: x.idB, idB: x.idA })).toEqual(expected);
      expect(await callSas({ ...x, dtlsA: x.dtlsB, dtlsB: x.dtlsA })).toEqual(expected);
      expect(await callSas({ ...x, idA: x.idB, idB: x.idA, dtlsA: x.dtlsB, dtlsB: x.dtlsA })).toEqual(expected);
    }
  });

  it('gives both sides of a contact the same symbols', async () => {
    for (let round = 0; round < 25; round += 1) {
      const idA = randomHex64();
      const idB = randomHex64();
      expect(await contactSas({ idA: idB, idB: idA })).toEqual(await contactSas({ idA, idB }));
    }
  });
});

describe('domain separation', () => {
  it('gives a call and a contact with the same identities different symbols', async () => {
    for (const v of vectors.call) {
      const call = await callSas(callInput(v));
      const contact = await contactSas({ idA: v.idA, idB: v.idB });
      expect(call).not.toEqual(contact);
    }
    for (let round = 0; round < 25; round += 1) {
      const x = randomCall();
      expect(hex(await callSasDigest(x))).not.toBe(hex(await contactSasDigest(x)));
    }
  });
});

describe('shape of the result', () => {
  it('is 7 integers from 0 to 63', async () => {
    expect(SAS_LENGTH).toBe(7);
    expect(SAS_ALPHABET_SIZE).toBe(64);
    for (let round = 0; round < 50; round += 1) {
      const x = randomCall();
      for (const indices of [await callSas(x), await contactSas(x)]) {
        expect(indices).toHaveLength(7);
        for (const index of indices) {
          expect(Number.isInteger(index)).toBe(true);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(64);
        }
      }
    }
  });

  it('takes the first 7 bytes of the digest, each shifted right by 2', () => {
    const digest = new Uint8Array(32).fill(0xaa);
    digest.set([0x00, 0x03, 0x04, 0xff, 0xfc, 0x80, 0x7f]);
    expect(sasIndices(digest)).toEqual([0, 0, 1, 63, 63, 32, 31]);
  });

  it('refuses a digest shorter than 7 bytes', () => {
    expect(() => sasIndices(new Uint8Array(6))).toThrow(RangeError);
  });
});

describe('every input counts', () => {
  it('changes the call symbols when any single input changes', async () => {
    const expected = await callSas(base);
    const variants: CallSasInput[] = [
      { ...base, callId: base.callId.slice(0, -1) + (base.callId.endsWith('A') ? 'B' : 'A') },
      { ...base, idA: flipLast(base.idA) },
      { ...base, idB: flipLast(base.idB) },
      { ...base, dtlsA: flipLast(base.dtlsA) },
      { ...base, dtlsB: flipLast(base.dtlsB) },
    ];
    for (const variant of variants) expect(await callSas(variant)).not.toEqual(expected);
  });

  it('changes the contact symbols when either identity changes', async () => {
    const expected = await contactSas(base);
    expect(await contactSas({ idA: flipLast(base.idA), idB: base.idB })).not.toEqual(expected);
    expect(await contactSas({ idA: base.idA, idB: flipLast(base.idB) })).not.toEqual(expected);
  });

  it('keeps an identity and a DTLS fingerprint in their own slots', async () => {
    // Moving a value from the identity pair to the DTLS pair must not give the same SAS.
    const moved = { ...base, idA: base.dtlsA, dtlsA: base.idA };
    expect(await callSas(moved)).not.toEqual(await callSas(base));
  });
});

describe('input validation', () => {
  it('rejects anything but 64 lowercase hex digits for the identities and fingerprints', async () => {
    const bad = ['', 'abc', base.idA.toUpperCase(), base.idA + '0', base.idA.slice(0, 63) + 'g', ` ${base.idA.slice(1)}`];
    for (const value of bad) {
      for (const field of ['idA', 'idB', 'dtlsA', 'dtlsB'] as const) {
        await expect(callSas({ ...base, [field]: value })).rejects.toBeInstanceOf(SasInputError);
      }
      await expect(contactSas({ idA: base.idA, idB: value })).rejects.toBeInstanceOf(SasInputError);
    }
  });

  it('accepts only the call ids that call.ts accepts', async () => {
    for (const callId of ['', 'short', 'a'.repeat(15), 'a'.repeat(65), 'with space in it!!', 'ñandú-ñandú-ñandú']) {
      await expect(callSas({ ...base, callId })).rejects.toBeInstanceOf(SasInputError);
    }
    await expect(callSas({ ...base, callId: 'a'.repeat(16) })).resolves.toHaveLength(7);
    await expect(callSas({ ...base, callId: 'Z_-9'.repeat(16) })).resolves.toHaveLength(7);
  });

  it('rejects values that are not strings', async () => {
    await expect(callSas({ ...base, idA: null as unknown as string })).rejects.toBeInstanceOf(SasInputError);
    await expect(contactSas({ idA: base.idA, idB: undefined as unknown as string })).rejects.toBeInstanceOf(SasInputError);
  });
});
