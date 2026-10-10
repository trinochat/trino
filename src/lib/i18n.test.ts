import { describe, expect, it } from 'vitest';
import { DICTS, LANGS, detectLang, interpolate, makeT, pickLang, type Lang } from './i18n';

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

describe('pickLang', () => {
  it('takes the first tag whose language Trino speaks, in the order given', () => {
    expect(pickLang(['fr-FR', 'pt-BR', 'en'])).toBe('pt');
    expect(pickLang(['de', 'en-GB', 'es'])).toBe('en');
  });

  it('reads the language out of a regional tag', () => {
    expect(pickLang(['es-CO'])).toBe('es');
    expect(pickLang(['es-419'])).toBe('es');
    expect(pickLang(['pt-BR'])).toBe('pt');
    expect(pickLang(['en-US'])).toBe('en');
  });

  it('ignores case and accepts an underscore separator', () => {
    expect(pickLang(['ES-co'])).toBe('es');
    expect(pickLang(['PT'])).toBe('pt');
    expect(pickLang(['pt_BR'])).toBe('pt');
  });

  it('compares the whole primary subtag, not its first two letters', () => {
    expect(pickLang(['esu', 'ptx-BR'])).toBe('en');
  });

  it('skips empty tags', () => {
    expect(pickLang(['', 'es'])).toBe('es');
  });

  it('falls back to English for an empty list or no supported language', () => {
    expect(pickLang([])).toBe('en');
    expect(pickLang(['fr-FR', 'de'])).toBe('en');
  });
});

describe('detectLang', () => {
  /** A `localStorage` stand-in that only knows the saved language. */
  const saved = (value: string | null) => ({
    getItem: (key: string) => (key === 'lang' ? value : null),
  });

  it('keeps a language the user saved over the system ones', () => {
    expect(detectLang(saved('pt'), { language: 'es-CO', languages: ['es-CO'] })).toBe('pt');
    expect(detectLang(saved('en'), { language: 'es-CO', languages: ['es-CO'] })).toBe('en');
  });

  it('ignores a saved value that is not one of its languages', () => {
    for (const value of ['fr', 'ES', 'es-CO', '', 'null']) {
      expect(detectLang(saved(value), { language: 'pt-BR', languages: ['pt-BR'] })).toBe('pt');
    }
  });

  it('walks navigator.languages in order when nothing is saved', () => {
    expect(detectLang(saved(null), { language: 'fr-FR', languages: ['fr-FR', 'pt-BR', 'en'] })).toBe('pt');
  });

  it('uses navigator.language when navigator.languages is empty or missing', () => {
    expect(detectLang(saved(null), { language: 'es-MX', languages: [] })).toBe('es');
    expect(detectLang(saved(null), { language: 'pt-PT' })).toBe('pt');
  });

  it('defaults to English', () => {
    expect(detectLang(saved(null), { language: 'fr-FR', languages: ['fr-FR', 'de-DE'] })).toBe('en');
  });
});

describe('interpolate', () => {
  it('replaces each {name} with its value', () => {
    expect(interpolate('{a} and {b}', { a: 'x', b: 'y' })).toBe('x and y');
    expect(interpolate('{n}/{n}', { n: 2 })).toBe('2/2');
  });

  it('turns numbers into text, zero included', () => {
    expect(interpolate('Paso {n} de {total}', { n: 0, total: 5 })).toBe('Paso 0 de 5');
  });

  it('leaves a placeholder without a value as it is', () => {
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(interpolate('{a}', { a: undefined })).toBe('{a}');
    expect(interpolate('{a}')).toBe('{a}');
  });

  it('does not read values from the object prototype', () => {
    expect(interpolate('{toString} {constructor}', {})).toBe('{toString} {constructor}');
  });

  it('inserts values literally: no $ patterns and no second pass', () => {
    expect(interpolate('{a} {b}', { a: '$& $1 $$', b: '{a}' })).toBe('$& $1 $$ {a}');
  });
});

describe('makeT', () => {
  /** A stand-in for DICTS, so these tests do not depend on texts that screens own. */
  const DICTS_FIXTURE: Record<Lang, Record<string, string>> = {
    es: { 'x.invite': '{handle} te invitó al grupo {name}', 'x.cancel': 'cancelar' },
    en: { 'x.invite': '{handle} invited you to the group {name}', 'x.cancel': 'cancel', 'x.onlyEn': 'only in English' },
    pt: { 'x.invite': '{handle} convidou você para o grupo {name}', 'x.cancel': 'cancelar' },
  };

  it('fills the placeholders of the chosen language', () => {
    expect(makeT('es', DICTS_FIXTURE)('x.invite', { handle: 'Ana', name: 'Familia' })).toBe(
      'Ana te invitó al grupo Familia',
    );
    expect(makeT('pt', DICTS_FIXTURE)('x.invite', { handle: 'Ana', name: 'Família' })).toBe(
      'Ana convidou você para o grupo Família',
    );
  });

  it('returns the raw text without values, as the existing calls expect', () => {
    expect(makeT('en', DICTS_FIXTURE)('x.invite')).toBe('{handle} invited you to the group {name}');
    expect(makeT('es', DICTS_FIXTURE)('x.cancel')).toBe('cancelar');
  });

  it('keeps the fallback order: the language, then English, then the key', () => {
    expect(makeT('xx' as Lang, DICTS_FIXTURE)('x.cancel')).toBe('cancel');
    expect(makeT('es', DICTS_FIXTURE)('x.onlyEn')).toBe('only in English');
    expect(makeT('es', DICTS_FIXTURE)('no.such.key')).toBe('no.such.key');
    expect(makeT('es', DICTS_FIXTURE)('no.such.key', { n: 1 })).toBe('no.such.key');
  });

  it('looks texts up in DICTS when no dictionary is given', () => {
    for (const lang of LANGS.map(l => l.code)) {
      const [key, text] = Object.entries(DICTS[lang]).find(([, value]) => !value.includes('{'))!;
      expect(makeT(lang)(key)).toBe(text);
    }
  });
});

const LANG_CODES = LANGS.map(l => l.code);

/** The `{name}` placeholders of a text, as a sorted set: what `interpolate` fills. */
const placeholdersOf = (text: string) =>
  [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), m => m[1]!))].sort();

// The contract of each screen area, and the rules for the new copy, live in
// src/lib/strings: <area>.test.ts and index.test.ts. These cover every text.
describe('Spanish copy', () => {
  it('uses no vosotros forms in Spanish', () => {
    const vosotros = Object.entries(DICTS.es)
      .filter(([, text]) => /(áis|éis)(?!\p{L})|\bvosotr|\bvuestr/iu.test(text))
      .map(([key]) => key);
    expect(vosotros).toEqual([]);
  });

  // Colombian and Latin American words: agregar, audífonos, parlantes, video,
  // celular, computador, archivo and toca or presiona. "Altavoz" stays fine for
  // speakerphone; the plural is the output device, which is "parlantes".
  it('uses Latin American rather than Spain-only words in Spanish', () => {
    const spainOnly = Object.entries(DICTS.es)
      .filter(([, text]) => /añ[aá]d|auricular|altavoces|vídeo|\bm[óo]vil|ordenador|fichero|\bpuls[aeá]/iu.test(text))
      .map(([key]) => key);
    expect(spainOnly).toEqual([]);
  });
});

// A placeholder that is missing or misspelt in one language shows up raw on
// screen ("{name}") for the people who use that language.
describe('placeholders', () => {
  it('are the same in every language, for every key', () => {
    const mismatched = Object.keys(DICTS.es).flatMap(key => {
      const byLang = LANG_CODES.map(lang => placeholdersOf(DICTS[lang][key] ?? '').join(', '));
      return byLang.every(found => found === byLang[0])
        ? []
        : [[key, Object.fromEntries(LANG_CODES.map((lang, i) => [lang, byLang[i]]))] as const];
    });
    expect(Object.fromEntries(mismatched)).toEqual({});
  });
});
