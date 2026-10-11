import { describe, expect, it } from 'vitest';
import turnDoc from '../../../docs/llamadas-turn.md?raw';
import { LANG_CODES } from './contract-test-utils';
import { call } from './call';
import { expectAreaContract } from './contract-test-utils';

// The texts of calls and verification (W6), with the prefixes call2 and verify.
const KEYS: string[] = [
  // The question when a call cannot be protected (TURN failed), on every call.
  'call2.consent.title', 'call2.consent.bodyOutgoing', 'call2.consent.bodyIncoming',
  'call2.consent.confirmOutgoing', 'call2.consent.confirmIncoming', 'call2.consent.cancelIncoming',
  // How the call travels: "03:21 · Conexión protegida", and what that means.
  'call2.mode.protected', 'call2.mode.direct', 'call2.mode.protectedHelp', 'call2.mode.directHelp',
  // An incoming call: in its dialog, and in the notification while the window is hidden.
  'call2.incoming.voice', 'call2.incoming.video',
  'call2.incoming.verified', 'call2.incoming.answer', 'call2.incoming.answerVideo', 'call2.incoming.answerAudio',
  'call2.incoming.decline',
  // The end card (Call:166-177), with why the call ended.
  'call2.end.title', 'call2.end.rejected', 'call2.end.noAnswer', 'call2.end.connection', 'call2.end.microphone',
  'call2.end.permission', 'call2.end.permissionHelp', 'call2.end.signal', 'call2.end.securityTitle',
  'call2.end.security', 'call2.end.logged', 'call2.end.mediaOff', 'call2.end.callAgain',
  // Before locking or closing the window during a call.
  'call2.endConfirm.title', 'call2.endConfirm.lock', 'call2.endConfirm.close',
  'call2.endConfirm.lockConfirm', 'call2.endConfirm.closeConfirm',
];

const PLACEHOLDERS = {
  'call2.consent.bodyIncoming': ['name'],
};

describe('call strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(call, { keys: KEYS, placeholders: PLACEHOLDERS });
  });

  // What src/call-confirm-dialog.test.tsx checks for the old keys until I5 deletes them.
  it('ask in Spanish, before a direct call, what docs/llamadas-turn.md quotes', () => {
    const title = call.es['call2.consent.title'];
    const body = call.es['call2.consent.bodyOutgoing'];
    expect([title, body]).toEqual(['No se pudo proteger la llamada.', '¿Llamar directo? Tu contacto verá tu IP.']);
    expect(turnDoc).toContain(`> ${title} ${body}`);
  });

  it('name Cloudflare when they explain a protected call (plan-cambios-11oct §6)', () => {
    expect(call.es['call2.mode.protectedHelp']).toBe(
      'Tu contacto no ve tu IP. La llamada pasa por un servidor de Cloudflare, que sí la ve.',
    );
    for (const lang of LANG_CODES) expect(call[lang]['call2.mode.protectedHelp']).toContain('Cloudflare');
  });

  // plan-cambios-11oct §4 (W6): the end card after the key of the connection changed.
  it('tell in Spanish why a call ended when the key of the connection changed', () => {
    expect(call.es['call2.end.security']).toBe(
      'La llamada terminó porque cambió la clave de la conexión. Vuelve a llamar y comparen los símbolos otra vez.',
    );
    expect(call.es['call2.end.logged']).toBe('Queda registrada en el chat.');
  });

  it.each(LANG_CODES)('promise nothing that is not built yet in %s', lang => {
    const soon = { es: /\bpronto\b/i, en: /\bsoon\b/i, pt: /\bem breve\b/i }[lang];
    const promises = Object.entries(call[lang]).filter(([, text]) => soon.test(text) || /@\w|\bTor\b/.test(text));
    expect(promises).toEqual([]);
  });
});
