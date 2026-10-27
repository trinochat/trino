import { describe, expect, it } from 'vitest';
import { makeT } from '../../lib/i18n';
import type { Msg } from '../types';
import {
  candidatesOf,
  confirmLines,
  defaultMode,
  MAX_PICKS,
  REPORT_CATEGORIES,
  reportData,
  shownFingerprint,
  type ReportCandidate,
} from './report-model';

const t = makeT('es');

const msg = (key: string, extra: Partial<Msg>): Msg => ({ key, side: 'them', ts: 1_791_916_200, ...extra });
const PHOTO = { url: 'u', key: 'k', sha256: 'e'.repeat(64), mime: 'image/jpeg', name: 'foto.jpg', size: 1_150_000, thumb: 'data:image/jpeg;base64,AA==' };

describe('the report model', () => {
  it('lists the kinds of design §6.2 in their order', () => {
    expect(REPORT_CATEGORIES).toEqual(['spam', 'harassment', 'impersonation', 'fraud', 'ncii', 'child', 'other']);
  });

  // U2: spam, only the key; a child at risk and intimate images, no content; the rest, with messages.
  it('starts each kind with what U2 says goes', () => {
    expect(defaultMode('spam')).toBe('key_only');
    expect(defaultMode('harassment')).toBe('messages');
    expect(defaultMode('other')).toBe('messages');
    expect(defaultMode('child')).toBe('description_only');
    expect(defaultMode('ncii')).toBe('description_only');
  });

  // Design test 26: in a group, only theirs and yours; calls are never messages.
  it('offers theirs and yours, in a group only the reported member\'s', () => {
    const group: Msg[] = [
      msg('a', { from: 'ana', text: 'de ana' }),
      msg('b', { from: 'papá', text: 'de papá' }),
      msg('c', { side: 'me', text: 'mío' }),
      msg('d', { from: 'ana', file: PHOTO }),
      msg('e', { from: 'ana', call: { id: 'x', video: false, outcome: 'missed', direction: 'in' } as never }),
    ];
    const offered = candidatesOf(group, 'ana');
    expect(offered.map(candidate => candidate.key)).toEqual(['a', 'c', 'd']);
    expect(offered[0].pick).toEqual({ ts: 1_791_916_200, side: 'them', from: 'ana', text: 'de ana', sha256: null });
    expect(offered[2].pick.sha256).toBe('e'.repeat(64));
    expect(offered[2].pick.text).toBeNull();
    // In a chat of two, everything but the calls.
    expect(candidatesOf(group, null).map(candidate => candidate.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shows a fingerprint as the boards do', () => {
    expect(shownFingerprint('8a2e.4913.56cf.db05')).toBe('8A2E 4913 56CF DB05');
  });

  // PropReportar card 4: the exact list of what goes.
  it('says exactly what goes, and what does not', () => {
    const chosen: ReportCandidate[] = candidatesOf(
      [
        msg('a', { text: 'Si no me contestas, voy a ir a tu casa.' }),
        msg('b', { side: 'me', text: 'Por favor, déjame en paz.' }),
        msg('c', { file: PHOTO }),
        msg('d', { text: 'Sé dónde trabajas.' }),
      ],
      null,
    );
    const lines = confirmLines(t, {
      name: 'lina',
      fingerprint: '1a2b.3c4d.5e6f.7a8b',
      selfName: 'lina',
      category: 'harassment',
      mode: 'messages',
      chosen,
      note: 'Me escribe todos los días.',
    });
    expect(lines.sends).toEqual([
      'la llave y la huella de lina (1A2B 3C4D 5E6F 7A8B) y el nombre que se puso;',
      '2 mensajes suyos, con su día;',
      '1 mensaje tuyo, con su día;',
      'que mandó fotos o archivos (1), con su tamaño aproximado y su día (no se envían);',
      '«Acoso, amenazas o insultos»;',
      'tu descripción.',
    ]);
    expect(lines.notSent).toBe(t('report.notSentMessages'));

    // Only the key: no messages, whatever was marked; no description, no line for it.
    const keyOnly = confirmLines(t, {
      name: 'lina',
      fingerprint: '1a2b.3c4d.5e6f.7a8b',
      selfName: null,
      category: 'child',
      mode: 'messages',
      chosen,
      note: '  ',
    });
    expect(keyOnly.sends).toEqual([
      'la llave y la huella de lina (1A2B 3C4D 5E6F 7A8B);',
      '«Un niño, niña o adolescente en riesgo»;',
    ]);
    expect(keyOnly.notSent).toBe(t('report.notSent'));
  });

  // U24: the e-mail gets only this block; never messages, photos or attachments.
  it('copies only the code, the kind, the fingerprint, the name, the day and the description', () => {
    const text = reportData(t, 'es', {
      id: 'R-7KQ2-9MXD',
      day: '2026-10-13',
      category: 'harassment',
      fingerprint: '1a2b.3c4d.5e6f.7a8b',
      selfName: 'lina',
      note: 'Me escribe todos los días.',
    });
    expect(text.split('\n')).toEqual([
      'Reporte R-7KQ2-9MXD',
      'Tipo: Acoso, amenazas o insultos',
      'Huella: 1A2B 3C4D 5E6F 7A8B',
      'Nombre que se puso: lina',
      'Día: 13 oct 2026',
      'Tu descripción: Me escribe todos los días.',
    ]);
    const bare = reportData(t, 'es', { id: 'R-A', day: '2026-10-13', category: 'spam', fingerprint: 'ab', selfName: null, note: '' });
    expect(bare).not.toMatch(/Nombre que se puso|Tu descripción/);
  });

  it('takes at most eleven messages', () => {
    expect(MAX_PICKS).toBe(11);
  });
});
