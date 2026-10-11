import { describe, expect, it } from 'vitest';
import { makeT } from '../../lib/i18n';
import { NOTIF_PREVIEWS } from '../../lib/prefs';
import { notificationContent } from './notification-content';

const t = makeT('es');
const text = { title: 'Ana Torres', text: '¿Nos vemos el jueves a las 6?', kind: 'text' as const };

// What a message notification shows at each level of Settings >
// Notifications (Settings:53-85). The shell's notifier (I6) sends it.
describe('notificationContent', () => {
  it('shows who writes and the text with "Nombre y mensaje"', () => {
    expect(notificationContent('full', text, t)).toEqual({ title: 'Ana Torres', body: '¿Nos vemos el jueves a las 6?' });
  });

  it('names a file or a sticker instead of a text', () => {
    expect(notificationContent('full', { title: 'Ana Torres', kind: 'file' }, t).body).toBe('Te envió un archivo');
    expect(notificationContent('full', { title: 'Ana Torres', kind: 'sticker' }, t).body).toBe('Te envió un sticker');
  });

  it('says "Nuevo mensaje" for a text that is empty', () => {
    expect(notificationContent('full', { title: 'Ana Torres', text: '  ', kind: 'text' }, t).body).toBe('Nuevo mensaje');
  });

  it('shows who writes but not what with "Solo el nombre"', () => {
    expect(notificationContent('name', text, t)).toEqual({ title: 'Ana Torres', body: 'Nuevo mensaje' });
    expect(notificationContent('name', { title: 'Ana Torres', kind: 'sticker' }, t).body).toBe('Nuevo mensaje');
  });

  it('shows neither who nor what with "Nada"', () => {
    expect(notificationContent('none', text, t)).toEqual({ title: 'Trino Chat', body: 'Nuevo mensaje' });
  });

  it('never carries an avatar, nor anything but a title and a body', () => {
    for (const level of NOTIF_PREVIEWS) {
      expect(Object.keys(notificationContent(level, text, t)).sort(), level).toEqual(['body', 'title']);
    }
  });
});
