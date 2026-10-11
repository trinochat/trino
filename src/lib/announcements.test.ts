import { describe, expect, it } from 'vitest';
import { BUNDLED_ANNOUNCEMENTS } from './announcements';

// The bundled news are Spanish copy too: Latin American words, as in strings
// (i18n.test.ts), which only checks the dictionaries.
describe('the bundled announcements', () => {
  it('speak the Spanish of Latin America: "agregar", not "añadir"', () => {
    const copy = BUNDLED_ANNOUNCEMENTS.map(announcement => `${announcement.title} ${announcement.body}`).join('\n');
    expect(copy).not.toMatch(/añad/i);
  });
});
