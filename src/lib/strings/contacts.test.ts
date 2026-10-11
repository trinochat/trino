import { describe, expect, it } from 'vitest';
import { contacts } from './contacts';
import { expectAreaContract } from './contract-test-utils';

// The texts of contacts and groups (W4), with the prefixes contacts,
// groupPanel and groupNew.
const KEYS: string[] = [
  // "Nuevo chat" and "Nueva llamada" (PropNuevoChat).
  'contacts.newChat.title',
  'contacts.newChat.titleCall',
  'contacts.newChat.search',
  'contacts.newChat.placeholder',
  'contacts.newChat.shortcuts',
  'contacts.newChat.newGroup',
  'contacts.newChat.addWithCode',
  'contacts.newChat.letterList',
  'contacts.newChat.noMatch',
  'contacts.newChat.addCode',
  'contacts.newChat.callTo',
  'contacts.newChat.verified',
  'contacts.newChat.empty',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'contacts.newChat.letterList': ['letter'],
  'contacts.newChat.noMatch': ['q'],
  'contacts.newChat.callTo': ['name'],
};

describe('contacts strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(contacts, { keys: KEYS, placeholders: PLACEHOLDERS });
  });

  // David decided on 11 Oct that the @name comes later, with the invitations
  // and Tor (plan-cambios-11oct §3.3, §8): no screen of this batch offers it.
  it('offer no @name, which comes later with the invitations', () => {
    for (const lang of ['es', 'en', 'pt'] as const) {
      const atName = Object.entries(contacts[lang]).filter(([, text]) => /@\p{L}|nombre de usuario|username/iu.test(text));
      expect(atName, lang).toEqual([]);
    }
  });

  it('speak the Spanish of Colombia, with "agregar"', () => {
    expect(contacts.es['contacts.newChat.addWithCode']).toBe('Agregar con código o QR');
    expect(contacts.es['contacts.newChat.noMatch']).toBe('Nadie en tus contactos coincide con «{q}».');
  });
});
