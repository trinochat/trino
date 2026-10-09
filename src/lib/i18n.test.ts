import { describe, expect, it } from 'vitest';
import { DICTS, LANGS } from './i18n';

// Every language must carry exactly the same keys, none of them empty:
// a missing key silently falls back to the raw key name in the UI.
describe('i18n dictionaries', () => {
  const reference = Object.keys(DICTS.es).sort();

  it('cover every language listed in the picker', () => {
    expect(Object.keys(DICTS).sort()).toEqual(LANGS.map(l => l.code).sort());
  });

  for (const lang of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
    it(`${lang} has the same keys as es`, () => {
      expect(Object.keys(DICTS[lang]).sort()).toEqual(reference);
    });

    it(`${lang} has no empty strings`, () => {
      const empty = Object.entries(DICTS[lang])
        .filter(([, v]) => !v.trim())
        .map(([k]) => k);
      expect(empty).toEqual([]);
    });
  }
});
