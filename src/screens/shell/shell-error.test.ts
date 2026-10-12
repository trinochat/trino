import { describe, expect, it } from 'vitest';
import { makeT } from '../../lib/i18n';
import { shellErrorText } from './shell-error';

const t = makeT('es');

// What the banner over the shell says (B2): forward_file checks for a relay
// before anything goes out, and sends to the members of a group one by one
// without waiting for an OK, so a group can be half reached.
describe('shellErrorText', () => {
  it('names the contact it could not reconnect with', () => {
    expect(shellErrorText(t, { kind: 'reconnect', handle: 'Ana' })).toBe('No se pudo reconectar con Ana.');
  });

  it('says that nothing went out when no server was up', () => {
    for (const group of [false, true]) {
      expect(shellErrorText(t, { kind: 'forward', reason: 'offline', group })).toBe(
        'No se pudo reenviar: no hay conexión con ningún servidor. No se envió nada.',
      );
    }
  });

  it('says the file is too large for the servers', () => {
    expect(shellErrorText(t, { kind: 'forward', reason: 'too_long', group: true })).toBe(
      'No se pudo reenviar: es demasiado grande para los servidores.',
    );
  });

  it('says that some members may have it when a group forward failed halfway', () => {
    for (const reason of ['other', 'no_session', 'not_accepted'] as const) {
      expect(shellErrorText(t, { kind: 'forward', reason, group: true })).toBe(
        'No se pudo reenviar el mensaje. Puede que algunos miembros del grupo ya lo hayan recibido.',
      );
    }
    expect(shellErrorText(t, { kind: 'forward', reason: 'other', group: false })).toBe('No se pudo reenviar el mensaje.');
  });
});
