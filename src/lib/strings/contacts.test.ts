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
  'contacts.add.refresh',
  'contacts.add.refreshButton',
  'contacts.add.refreshed',
  'contacts.add.sharesKeys',
  'contacts.add.nameTaken',
  'contacts.add.replace',
  'contacts.add.replaceHint',
  'contacts.add.nameTakenError',
  'contacts.add.failed',
  'contacts.add.added',
  // Under the add and share panels: no messages from strangers in this batch.
  'contacts.mutualNote',
  // The dialog and its tabs (Contacts:40-51).
  'contacts.dialog.title',
  'contacts.dialog.tabs',
  'contacts.dialog.tabAdd',
  'contacts.dialog.tabShare',
  'contacts.dialog.tabInvites',
  'contacts.dialog.tabInvitesCount',
  // Your code (Contacts:83-105), also in Settings.
  'contacts.share.qr',
  'contacts.share.safe',
  'contacts.share.codeLabel',
  'contacts.share.copy',
  'contacts.share.copied',
  'contacts.share.copyFailed',
  'contacts.share.saveQr',
  'contacts.share.saveFailed',
  'contacts.share.yourKey',
  'contacts.share.keyNote',
  'contacts.share.loading',
  'contacts.share.failed',
  // Group invitations (Contacts:108-123), and the note about strangers.
  'contacts.invites.from',
  'contacts.invites.fromOne',
  'contacts.invites.note',
  'contacts.invites.join',
  'contacts.invites.joinLabel',
  'contacts.invites.decline',
  'contacts.invites.declineLabel',
  'contacts.invites.joinFailed',
  'contacts.invites.declineFailed',
  'contacts.invites.empty',
  'contacts.invites.strangerOne',
  'contacts.invites.strangerMany',
  // The group panel (Group:70-115) and its dialogs.
  'groupPanel.memberCount',
  'groupPanel.memberCountOne',
  'groupPanel.adminIs',
  'groupPanel.adminYou',
  'groupPanel.rename',
  'groupPanel.mute',
  'groupPanel.ttl',
  'groupPanel.ttlOff',
  'groupPanel.ttl30s',
  'groupPanel.ttl5m',
  'groupPanel.ttl1h',
  'groupPanel.ttl1d',
  'groupPanel.ttl1w',
  'groupPanel.ttlOn',
  'groupPanel.ttlOffNote',
  'groupPanel.members',
  'groupPanel.membersLoading',
  'groupPanel.membersFailed',
  'groupPanel.invite',
  'groupPanel.you',
  'groupPanel.statusMember',
  'groupPanel.statusAdmin',
  'groupPanel.verified',
  'groupPanel.unverified',
  'groupPanel.viaGroup',
  'groupPanel.notContact',
  'groupPanel.write',
  'groupPanel.writeTo',
  'groupPanel.remove',
  'groupPanel.signed',
  'groupPanel.leave',
  'groupPanel.delete',
  'groupPanel.ended',
  'groupPanel.notAdmin',
  'groupPanel.leaveTitle',
  'groupPanel.leaveBody',
  'groupPanel.leaveFailed',
  'groupPanel.deleteTitle',
  'groupPanel.deleteBody',
  'groupPanel.deleteFailed',
  'groupPanel.removeTitle',
  'groupPanel.removeBody',
  'groupPanel.removeConfirm',
  'groupPanel.removeFailed',
  'groupPanel.name',
  'groupPanel.renameFailed',
  'groupPanel.inviteTitle',
  'groupPanel.inviteHint',
  'groupPanel.inviteNone',
  'groupPanel.inviteList',
  'groupPanel.inviting',
  'groupPanel.invitePartial',
  // A new group (a deviation of the canvas: no board draws it).
  'groupNew.title',
  'groupNew.adminNote',
  'groupNew.create',
  'groupNew.creating',
  'groupNew.adding',
  'groupNew.failed',
  'groupNew.partial',
  'groupNew.open',
  'groupNew.noContacts',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'contacts.newChat.letterList': ['letter'],
  'contacts.newChat.noMatch': ['q'],
  'contacts.newChat.callTo': ['name'],
  'contacts.add.verifyNote': ['name'],
  'contacts.add.add': ['name'],
  'contacts.add.replaceButton': ['name'],
  'contacts.add.known': ['name'],
  'contacts.add.refresh': ['name'],
  'contacts.add.refreshButton': ['name'],
  'contacts.add.refreshed': ['name'],
  'contacts.add.sharesKeys': ['name'],
  'contacts.add.nameTaken': ['name'],
  'contacts.add.replace': ['name'],
  'contacts.add.added': ['name'],
  'contacts.dialog.tabInvitesCount': ['n'],
  'contacts.invites.from': ['count', 'name'],
  'contacts.invites.fromOne': ['name'],
  'contacts.invites.joinLabel': ['name'],
  'contacts.invites.declineLabel': ['name'],
  'contacts.invites.joinFailed': ['from', 'name'],
  'contacts.invites.declineFailed': ['name'],
  'contacts.invites.strangerMany': ['n'],
  'groupPanel.memberCount': ['n'],
  'groupPanel.adminIs': ['name'],
  'groupPanel.ttlOn': ['time'],
  'groupPanel.writeTo': ['name'],
  'groupPanel.remove': ['name'],
  'groupPanel.leaveTitle': ['group'],
  'groupPanel.deleteTitle': ['group'],
  'groupPanel.removeTitle': ['name'],
  'groupPanel.removeFailed': ['name'],
  'groupPanel.inviteTitle': ['group'],
  'groupPanel.inviting': ['done', 'name', 'total'],
  'groupPanel.invitePartial': ['names'],
  'groupNew.adding': ['done', 'name', 'total'],
  'groupNew.partial': ['names'],
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

  it('say that a contact verifies you on a call, not with your key', () => {
    expect(contacts.es['contacts.share.keyNote']).toBe(
      'Para verificarte, tus contactos comparan contigo los símbolos de una llamada.',
    );
  });

  // K8 names a contact that holds even one of a code's keys: only all three
  // make the same person, and the same keys under the same name refresh it.
  it('call a contact the same person only when it has every key of the code', () => {
    expect(contacts.es['contacts.add.sharesKeys']).toBe(
      'Tu contacto «{name}» ya tiene alguna de las claves de este código. Dos contactos no pueden compartir una clave, así que Trino no lo agrega.',
    );
    expect(contacts.es['contacts.add.refresh']).toBe(
      'Ya tienes a «{name}» en tus contactos, con estas mismas claves. Si continúas, Trino cambia el código que tenía guardado por este.',
    );
    for (const lang of ['es', 'en', 'pt'] as const) {
      expect(contacts[lang]['contacts.add.sharesKeys'], lang).not.toMatch(/persona|person|pessoa/i);
    }
  });

  // Plan §1.4: the timer is per device, since a group-wide one would change
  // the signed bytes of the roster; the board's "para todo el grupo" is not true.
  it('say that each person sets the time of their own messages in a group', () => {
    expect(contacts.es['groupPanel.ttlOn']).toBe(
      'Tus mensajes nuevos en este grupo se borran de los equipos de todos después de {time}. Cada persona elige el tiempo de sus propios mensajes.',
    );
    expect(contacts.es['groupPanel.inviteHint']).toBe('Solo le llega a contactos que también te tengan agregado.');
  });

  // accept_group_invite and decline_group_invite take the invitation out
  // before anything else, and keep it out when they fail: no retry to promise.
  it('promise no retry for an invitation the backend already took out', () => {
    expect(contacts.es['contacts.invites.joinFailed']).toBe(
      'No se pudo entrar a «{name}», y esa invitación ya no se puede usar. Pídele a {from} que te invite otra vez.',
    );
    for (const lang of ['es', 'en', 'pt'] as const) {
      for (const key of ['contacts.invites.joinFailed', 'contacts.invites.declineFailed']) {
        expect(contacts[lang][key], `${lang} ${key}`).not.toMatch(/inténtalo|try again|tente de novo/i);
      }
    }
  });

  // Plan §1.2: the event of a stranger is dropped, so Trino can only say someone tried.
  it('say what Trino knows of a stranger, and no more', () => {
    expect(contacts.es['contacts.invites.strangerOne']).toBe(
      'Alguien que no está en tus contactos intentó escribirte. Trino todavía no puede mostrarte quién es: pídele su código.',
    );
  });
});
