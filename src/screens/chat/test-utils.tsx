/**
 * Helpers for the tests of the chat. Not part of the screens: only test files
 * import this module.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nContext, makeT, type Lang, type TFunction } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import type { Msg } from '../types';

const lookups = new Map<Lang, TFunction>();

/** The text lookup of a language, the same function every time. */
export function tFor(lang: Lang): TFunction {
  let t = lookups.get(lang);
  if (!t) {
    t = makeT(lang);
    lookups.set(lang, t);
  }
  return t;
}

/** The language and the texts the app gives every screen. */
export function LangWrapper({ lang = 'es', children }: { lang?: Lang; children?: ReactNode }) {
  return (
    <LangCtx.Provider value={{ lang, setLang: () => {} }}>
      <I18nContext.Provider value={tFor(lang)}>{children}</I18nContext.Provider>
    </LangCtx.Provider>
  );
}

/** Renders `ui` in a language, Spanish unless told otherwise. */
export function renderIn(ui: ReactElement, lang: Lang = 'es', options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  return render(ui, { wrapper: ({ children }) => <LangWrapper lang={lang}>{children}</LangWrapper>, ...options });
}

/** Epoch seconds of a local date and time, like `Msg.ts`. */
export function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000);
}

/** A message from the contact, with what the test changes. */
export function message(key: string, ts: number, extra: Partial<Msg> = {}): Msg {
  return { key, side: 'them', ts, text: key, ...extra };
}

/** The classes of an element, as a list. */
export function classesOf(element: Element | null | undefined): string[] {
  return (element?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}
