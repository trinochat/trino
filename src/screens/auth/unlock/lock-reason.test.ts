import { describe, expect, it } from 'vitest';
import { makeT } from '../../../lib/i18n';
import { lockReasonText } from './lock-reason';

const es = makeT('es');
const en = makeT('en');

describe('lockReasonText', () => {
  it('says why Trino is locked, as Unlock:55 does', () => {
    expect(lockReasonText({ kind: 'idle', minutes: 5 }, es)).toBe('Trino se bloqueó tras 5 minutos sin actividad.');
    expect(lockReasonText({ kind: 'manual' }, es)).toBe('Bloqueaste Trino.');
    expect(lockReasonText({ kind: 'cold' }, es)).toBe('Escribe tu contraseña para abrir tus chats.');
  });

  // "1 minutos" would be wrong in every language.
  it('says one minute in the singular', () => {
    expect(lockReasonText({ kind: 'idle', minutes: 1 }, es)).toBe('Trino se bloqueó tras 1 minuto sin actividad.');
    expect(lockReasonText({ kind: 'idle', minutes: 1 }, en)).toBe('Trino locked after 1 minute without activity.');
    expect(lockReasonText({ kind: 'idle', minutes: 15 }, en)).toBe('Trino locked after 15 minutes without activity.');
  });

  // Design §7.2 and §11.3: Trino also locks with Windows (CL-6a), and the
  // unlock screen says which of the two locked it.
  it('says when locking Windows or the computer going to sleep locked Trino', () => {
    expect(lockReasonText({ kind: 'system', cause: 'session' }, es)).toBe('Trino se bloqueó porque bloqueaste Windows.');
    expect(lockReasonText({ kind: 'system', cause: 'suspend' }, es)).toBe('Trino se bloqueó porque el computador se suspendió.');
    expect(lockReasonText({ kind: 'system', cause: 'session' }, en)).toBe('Trino locked because you locked Windows.');
    expect(lockReasonText({ kind: 'system', cause: 'suspend' }, en)).toBe('Trino locked because the computer went to sleep.');
    const pt = makeT('pt');
    expect(lockReasonText({ kind: 'system', cause: 'session' }, pt)).toBe('O Trino foi bloqueado porque você bloqueou o Windows.');
    expect(lockReasonText({ kind: 'system', cause: 'suspend' }, pt)).toBe('O Trino foi bloqueado porque o computador entrou em suspensão.');
  });
});
