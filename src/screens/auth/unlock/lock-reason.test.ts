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
});
