/**
 * The texts of calls and verification (W6), under `call2.*` and `verify.*`.
 * Its contract is call.test.ts. The old call screen's `call.*` texts stay in
 * legacy.ts until the integration (I5) deletes them with that screen.
 */
import type { AreaStrings } from './types';

export const call: AreaStrings = {
  es: {
    // docs/llamadas-turn.md quotes the title and the outgoing question.
    'call2.consent.title': 'No se pudo proteger la llamada.',
    'call2.consent.bodyOutgoing': '¿Llamar directo? Tu contacto verá tu IP.',
    'call2.consent.bodyIncoming': '¿Contestar directo? {name} verá tu IP.',
    'call2.consent.confirmOutgoing': 'Llamar directo',
    'call2.consent.confirmIncoming': 'Contestar directo',
    'call2.consent.cancelIncoming': 'No contestar',
    'call2.mode.protected': 'Conexión protegida',
    'call2.mode.direct': 'Conexión directa',
    'call2.mode.protectedHelp': 'Tu contacto no ve tu IP. La llamada pasa por un servidor de Cloudflare, que sí la ve.',
    'call2.mode.directHelp': 'Tu contacto puede ver tu IP.',
  },
  en: {
    'call2.consent.title': 'The call could not be protected.',
    'call2.consent.bodyOutgoing': 'Call directly? Your contact will see your IP address.',
    'call2.consent.bodyIncoming': 'Answer directly? {name} will see your IP address.',
    'call2.consent.confirmOutgoing': 'Call directly',
    'call2.consent.confirmIncoming': 'Answer directly',
    'call2.consent.cancelIncoming': 'Don’t answer',
    'call2.mode.protected': 'Protected connection',
    'call2.mode.direct': 'Direct connection',
    'call2.mode.protectedHelp':
      'Your contact does not see your IP address. The call goes through a Cloudflare server, which does.',
    'call2.mode.directHelp': 'Your contact can see your IP address.',
  },
  pt: {
    'call2.consent.title': 'Não foi possível proteger a chamada.',
    'call2.consent.bodyOutgoing': 'Ligar direto? Seu contato verá seu IP.',
    'call2.consent.bodyIncoming': 'Atender direto? {name} verá seu IP.',
    'call2.consent.confirmOutgoing': 'Ligar direto',
    'call2.consent.confirmIncoming': 'Atender direto',
    'call2.consent.cancelIncoming': 'Não atender',
    'call2.mode.protected': 'Conexão protegida',
    'call2.mode.direct': 'Conexão direta',
    'call2.mode.protectedHelp': 'Seu contato não vê seu IP. A chamada passa por um servidor da Cloudflare, que vê.',
    'call2.mode.directHelp': 'Seu contato pode ver seu IP.',
  },
};
