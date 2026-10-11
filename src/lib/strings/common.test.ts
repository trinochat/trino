import { describe, expect, it } from 'vitest';
import { common } from './common';
import { expectAreaContract } from './contract-test-utils';

// Shared by every redesigned screen and owned by the parent: a unit that
// needs another shared word adds it under its own prefix instead. E0c added
// the texts of a call event, which the chat (W3) and the call log (W2) both
// show through src/lib/call-events.ts.
const KEYS = [
  'common2.cancel', 'common2.close', 'common2.retry', 'common2.back', 'common2.save',
  'common2.copy', 'common2.copied', 'common2.delete', 'common2.add', 'common2.done',
  'common2.more',
  'time2.today', 'time2.yesterday', 'time2.justNow',
  'callEvent.outgoing', 'callEvent.incoming', 'callEvent.missed',
  'callEvent.videoOutgoing', 'callEvent.videoIncoming', 'callEvent.videoMissed',
  'callEvent.rowOutgoing', 'callEvent.rowIncoming', 'callEvent.rowMissed',
  'callEvent.declined', 'callEvent.unanswered', 'callEvent.cancelled', 'callEvent.failed',
  'callEvent.seconds', 'callEvent.minutes', 'callEvent.hours',
  'callEvent.callBack',
];

const PLACEHOLDERS = {
  'callEvent.seconds': ['n'],
  'callEvent.minutes': ['n'],
  'callEvent.hours': ['n'],
};

describe('common strings', () => {
  it('have exactly the shared keys, with the placeholders of the call lengths', () => {
    expectAreaContract(common, { keys: KEYS, placeholders: PLACEHOLDERS });
  });

  it('say in Spanish what the plan fixed', () => {
    expect(common.es).toEqual({
      'common2.cancel': 'Cancelar',
      'common2.close': 'Cerrar',
      'common2.retry': 'Reintentar',
      'common2.back': 'Atrás',
      'common2.save': 'Guardar',
      'common2.copy': 'Copiar',
      'common2.copied': 'Copiado',
      'common2.delete': 'Eliminar',
      'common2.add': 'Agregar',
      'common2.done': 'Listo',
      'common2.more': 'Más opciones',
      'time2.today': 'Hoy',
      'time2.yesterday': 'Ayer',
      'time2.justNow': 'Ahora',
      // PropLlamadas: "Llamada saliente · 4 min", "Llamada perdida",
      // "Saliente · No contestó", "Videollamada entrante · 25 min".
      'callEvent.outgoing': 'Llamada saliente',
      'callEvent.incoming': 'Llamada entrante',
      'callEvent.missed': 'Llamada perdida',
      'callEvent.videoOutgoing': 'Videollamada saliente',
      'callEvent.videoIncoming': 'Videollamada entrante',
      'callEvent.videoMissed': 'Videollamada perdida',
      'callEvent.rowOutgoing': 'Saliente',
      'callEvent.rowIncoming': 'Entrante',
      'callEvent.rowMissed': 'Perdida',
      'callEvent.declined': 'Rechazada',
      'callEvent.unanswered': 'No contestó',
      'callEvent.cancelled': 'Cancelada',
      'callEvent.failed': 'No se pudo conectar',
      'callEvent.seconds': '{n} s',
      'callEvent.minutes': '{n} min',
      'callEvent.hours': '{n} h',
      'callEvent.callBack': 'Devolver llamada',
    });
  });
});
