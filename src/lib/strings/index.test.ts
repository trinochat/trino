import { describe, expect, it } from 'vitest';
import { DICTS, type Lang } from '../i18n';
import { LANG_CODES, startsWithCapital } from './contract-test-utils';
import { AREAS, NAMESPACES, mergeAreas } from './index';
import type { AreaStrings } from './types';

type AreaName = keyof typeof AREAS;
const AREA_NAMES = Object.keys(AREAS) as AreaName[];
/** The areas of the redesign: everything but the texts of the old screens. */
const NEW_AREAS = AREA_NAMES.filter(name => name !== 'legacy');

const prefixOf = (key: string) => key.slice(0, key.indexOf('.'));

/** Every key of an area, in any of its languages. */
const keysOf = (area: AreaStrings) => [...new Set(LANG_CODES.flatMap(lang => Object.keys(area[lang])))];

/** The entries of every new area in one language, as [area, key, text]. */
const newEntries = (lang: Lang) =>
  NEW_AREAS.flatMap(name => Object.entries(AREAS[name][lang]).map(([key, text]) => [name, key, text] as const));

describe('the string areas', () => {
  it('are the old screens, the shared words and one area per unit of the redesign', () => {
    expect(AREA_NAMES).toEqual(['legacy', 'common', 'auth', 'shell', 'chat', 'contacts', 'settings', 'call']);
    expect(Object.keys(NAMESPACES).sort()).toEqual([...AREA_NAMES].sort());
  });

  it('each speak every language of the app', () => {
    for (const name of AREA_NAMES) {
      expect(Object.keys(AREAS[name]).sort(), name).toEqual([...LANG_CODES].sort());
    }
  });

  it('never share a key', () => {
    const owners = new Map<string, AreaName[]>();
    for (const name of AREA_NAMES) {
      for (const key of keysOf(AREAS[name])) owners.set(key, [...(owners.get(key) ?? []), name]);
    }
    expect([...owners].filter(([, names]) => names.length > 1)).toEqual([]);
  });

  it('never share a prefix', () => {
    const prefixes = AREA_NAMES.flatMap(name => NAMESPACES[name]);
    expect(prefixes.filter((prefix, i) => prefixes.indexOf(prefix) !== i)).toEqual([]);
  });

  it('only use the prefixes of their own namespace', () => {
    const strays = AREA_NAMES.flatMap(name =>
      keysOf(AREAS[name])
        .filter(key => !NAMESPACES[name].includes(prefixOf(key)))
        .map(key => `${name}: ${key}`),
    );
    expect(strays).toEqual([]);
  });

  it('give every unit of the redesign its own prefixes', () => {
    expect(NAMESPACES.common).toEqual(['common2', 'time2']);
    expect(NAMESPACES.auth).toEqual(['onb', 'unlock2', 'start', 'titlebar']);
    expect(NAMESPACES.shell).toEqual(['shell', 'inbox', 'forward']);
    expect(NAMESPACES.chat).toEqual(['chat2', 'composer2', 'msg2', 'channel', 'media', 'emoji', 'sticker2']);
    expect(NAMESPACES.contacts).toEqual(['contacts', 'groupPanel', 'groupNew']);
    expect(NAMESPACES.settings).toEqual(['settings2', 'contactInfo']);
    expect(NAMESPACES.call).toEqual(['call2', 'verify']);
  });
});

describe('mergeAreas', () => {
  it('puts the keys of all the areas into one dictionary per language', () => {
    const a: AreaStrings = { es: { 'a.x': 'A' }, en: { 'a.x': 'A en' }, pt: { 'a.x': 'A pt' } };
    const b: AreaStrings = { es: { 'b.y': 'B' }, en: { 'b.y': 'B en' }, pt: { 'b.y': 'B pt' } };
    expect(mergeAreas({ a, b })).toEqual({
      es: { 'a.x': 'A', 'b.y': 'B' },
      en: { 'a.x': 'A en', 'b.y': 'B en' },
      pt: { 'a.x': 'A pt', 'b.y': 'B pt' },
    });
  });

  it('does not change the areas it merges', () => {
    const a: AreaStrings = { es: { 'a.x': 'A' }, en: { 'a.x': 'A' }, pt: { 'a.x': 'A' } };
    mergeAreas({ a, b: { es: { 'b.y': 'B' }, en: {}, pt: {} } });
    expect(a.es).toEqual({ 'a.x': 'A' });
  });

  it('is what the app looks texts up in', () => {
    expect(DICTS).toEqual(mergeAreas(AREAS));
  });
});

// Rules for the copy of the redesign. The old screens' texts (legacy) are
// lowercase and are deleted screen by screen, so they are left out.
describe.each(LANG_CODES)('the new copy in %s', lang => {
  it('starts every text with a capital letter', () => {
    const lower = newEntries(lang)
      .filter(([, , text]) => !startsWithCapital(text))
      .map(([name, key]) => `${name}: ${key}`);
    expect(lower).toEqual([]);
  });

  it('promises neither message requests nor trino2 codes, which do not exist yet', () => {
    const promises = newEntries(lang)
      .filter(([, , text]) => /solicitud|solicitaç|request|trino2/i.test(text))
      .map(([name, key]) => `${name}: ${key}`);
    expect(promises).toEqual([]);
  });

  it('does not say that contacts will see the photo, which stays on this device', () => {
    const seesPhoto = newEntries(lang)
      .filter(([, , text]) => promisesPhotoToOthers(text))
      .map(([name, key]) => `${name}: ${key}`);
    expect(seesPhoto).toEqual([]);
  });
});

/** One of the alternatives as a whole word, accents included (`\b` stops at "á"). */
const anyWord = (alternatives: string) => new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, 'iu');

const PHOTO = /foto|photo/i;
const SEES = anyWord('ver|ven|vea|vean|verá|verán|see|sees|seen|vê|veem|veja|vejam|verão|visible|visível');
/** Who would see it: the contacts, the others, everyone. */
const PEOPLE = anyWord(
  'contactos?|contacts?|contatos?|otros|otras|others?|demás|outros|outras|everyone|everybody|anyone|todo el mundo|cualquiera|people|gente|personas|pessoas|miembros|members|membros',
);
/** Forms that already say other people see it. */
const OTHERS_SEE = anyWord('verán|vean|verão|vejam|veem|will see|can see|podrán ver|pueden ver|podem ver|poderão ver');
const NEGATION = anyWord('no|not|não|nunca|never|nadie|nobody|ninguém|cannot|(?:do|does|did|wo|ca|is|are)n[’\']t');

/**
 * Whether a sentence of the text says that other people see the photo: it
 * names the photo, a seeing verb and who sees it (or a form that implies
 * them, such as "verán"), and does not deny it. "Ver foto" and "Tus
 * contactos no ven tu foto" pass.
 */
function promisesPhotoToOthers(text: string): boolean {
  return text
    .split(/[.?!]/)
    .some(
      sentence =>
        PHOTO.test(sentence) &&
        SEES.test(sentence) &&
        (PEOPLE.test(sentence) || OTHERS_SEE.test(sentence)) &&
        !NEGATION.test(sentence),
    );
}

// The rule above guards the honest copy of R3.4 and R7 without blocking the
// plain labels the chat needs. A unit cannot change this file (plan §3).
describe('promisesPhotoToOthers', () => {
  it.each([
    'Tus contactos verán tu foto.',
    'Tu foto la verán en tus chats',
    'Your contacts will see your photo.',
    'Others can see your photo',
    'Everyone sees your photo',
    'Seus contatos verão sua foto.',
    'Seus contatos veem sua foto',
  ])('flags "%s"', text => {
    expect(promisesPhotoToOthers(text)).toBe(true);
  });

  it.each([
    'Ver foto',
    'See photo',
    'Ver todas las fotos',
    'Abrir la foto en grande',
    'Tu foto se queda en este equipo.',
    'Tus contactos todavía no ven tu foto.',
    "Your contacts don't see your photo yet.",
    'Seus contatos ainda não veem sua foto.',
  ])('lets "%s" through', text => {
    expect(promisesPhotoToOthers(text)).toBe(false);
  });
});
