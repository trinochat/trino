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
  // Adding a contact from its code (Contacts:54-80).
  'contacts.add.codeLabel',
  'contacts.add.checking',
  'contacts.add.invalid',
  'contacts.add.checkFailed',
  'contacts.add.valid',
  'contacts.add.theirKey',
  'contacts.add.verifyNote',
  'contacts.add.add',
  'contacts.add.replaceButton',
  'contacts.add.nameLabel',
  'contacts.add.nameEmpty',
  'contacts.add.known',
  'contacts.add.nameTaken',
  'contacts.add.replace',
  'contacts.add.replaceHint',
  'contacts.add.nameTakenError',
  'contacts.add.failed',
  'contacts.add.added',
  // Under the add and share panels: no messages from strangers in this batch.
  'contacts.mutualNote',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'contacts.newChat.letterList': ['letter'],
  'contacts.newChat.noMatch': ['q'],
  'contacts.newChat.callTo': ['name'],
  'contacts.add.verifyNote': ['name'],
  'contacts.add.add': ['name'],
  'contacts.add.replaceButton': ['name'],
  'contacts.add.known': ['name'],
  'contacts.add.nameTaken': ['name'],
  'contacts.add.replace': ['name'],
  'contacts.add.added': ['name'],
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

  // Only a call's symbols verify a contact (David, 10 Oct; plan-cambios-11oct
  // §3.1): no copy offers comparing a key as a way to verify.
  it('verify only through a call, never by comparing a key', () => {
    expect(contacts.es['contacts.add.verifyNote']).toBe(
      'Para verificar a {name}, llámale y comparen los símbolos de la llamada. También puedes hacerlo después desde el chat.',
    );
    for (const lang of ['es', 'en', 'pt'] as const) {
      const keyCompare = Object.entries(contacts[lang]).filter(([, text]) =>
        /compar\p{L}* (esta|la|tu|su) clave|compare (this|the|your|their) key|compar\p{L}* (esta|a|sua) chave/iu.test(text),
      );
      expect(keyCompare, lang).toEqual([]);
    }
  });

  // Plan §1.3: nobody can write to you without being added; the board's
  // "le llegará como solicitud" becomes this.
  it('say that both have to add each other', () => {
    expect(contacts.es['contacts.mutualNote']).toBe('Para hablar, los dos tienen que agregarse con su código.');
  });
});
