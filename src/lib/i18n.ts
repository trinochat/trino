import { createContext, useContext } from 'react';
import { AREAS, mergeAreas } from './strings';

export type Lang = 'es' | 'en' | 'pt';

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Português' },
];

type Dict = Record<string, string>;

/**
 * Every text of the app, by language. The texts live in `src/lib/strings`,
 * one file per screen area; this is all of them merged.
 */
export const DICTS: Record<Lang, Dict> = mergeAreas(AREAS);

function isLang(value: unknown): value is Lang {
  return LANGS.some(l => l.code === value);
}

/**
 * The first tag whose primary subtag (case-insensitive) is a language Trino
 * speaks: `es-CO` gives es and `pt-BR` gives pt. English when none is.
 */
export function pickLang(languages: readonly string[]): Lang {
  for (const tag of languages) {
    const primary = tag.split(/[-_]/, 1)[0]!.toLowerCase();
    if (isLang(primary)) return primary;
  }
  return 'en';
}

/** What `detectLang` reads from `navigator`; `languages` is missing in older webviews. */
export interface LangNavigator {
  readonly language: string;
  readonly languages?: readonly string[];
}

/** The saved `lang` if it is valid, otherwise the system's preferred languages, in order. */
export function detectLang(
  storage: Pick<Storage, 'getItem'> = localStorage,
  nav: LangNavigator = navigator,
): Lang {
  const saved = storage.getItem('lang');
  if (isLang(saved)) return saved;
  return pickLang(nav.languages?.length ? nav.languages : [nav.language]);
}

/** Values for the `{name}` placeholders of a text. */
export type TVars = Readonly<Record<string, string | number | undefined>>;

/** Looks a key up in the current language and fills its placeholders. */
export type TFunction = (key: string, vars?: TVars) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Replaces each `{name}` with `String(vars[name])`, in one pass and literally.
 * A placeholder without a value stays as it is, so it shows up in review.
 */
export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * The text lookup for a language: that language, then English, then the key
 * itself. `dicts` is `DICTS` unless a test passes its own.
 */
export function makeT(lang: Lang, dicts: Readonly<Record<Lang, Dict>> = DICTS): TFunction {
  const en = dicts.en;
  const d = dicts[lang] ?? en;
  return (key, vars) => interpolate(d[key] ?? en[key] ?? key, vars);
}

export const I18nContext = createContext<TFunction>((key) => key);

export function useT(): TFunction {
  return useContext(I18nContext);
}
