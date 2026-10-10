import { describe, expect, it } from 'vitest';
import { common } from './common';
import { expectAreaContract } from './contract-test-utils';

// Shared by every redesigned screen and frozen after E0: a unit that needs
// another shared word adds it under its own prefix instead.
const KEYS = [
  'common2.cancel', 'common2.close', 'common2.retry', 'common2.back', 'common2.save',
  'common2.copy', 'common2.copied', 'common2.delete', 'common2.add', 'common2.done',
  'common2.more',
  'time2.today', 'time2.yesterday', 'time2.justNow',
];

describe('common strings', () => {
  it('have exactly the frozen shared keys, without placeholders', () => {
    expectAreaContract(common, { keys: KEYS });
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
    });
  });
});
