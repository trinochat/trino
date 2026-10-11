/**
 * Helpers for the tests of the chat. Not part of the screens: only test files
 * import this module.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nContext, makeT, type Lang, type TFunction } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { ToastProvider } from '../../ui';
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

/** The language, the texts and the toasts the app gives every screen (the toasts from its root, step I1). */
export function LangWrapper({ lang = 'es', children }: { lang?: Lang; children?: ReactNode }) {
  return (
    <LangCtx.Provider value={{ lang, setLang: () => {} }}>
      <I18nContext.Provider value={tFor(lang)}>
        <ToastProvider closeLabel={tFor(lang)('common2.close')}>{children}</ToastProvider>
      </I18nContext.Provider>
    </LangCtx.Provider>
  );
}

/** Renders `ui` in a language, Spanish unless told otherwise; a rerender keeps the wrapper and its toasts. */
export function renderIn(ui: ReactElement, lang: Lang = 'es', options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  return render(ui, { wrapper: ({ children }) => <LangWrapper lang={lang}>{children}</LangWrapper>, ...options });
}

/** A promise the test settles when it chooses, such as files still on their way. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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

/** The colour classes of an element (`text-ui-muted`, `hover:bg-ui-raised`), not its text sizes (`text-ui-md`). */
export function colourClasses(element: Element): string[] {
  return classesOf(element).filter(
    name =>
      /^(?:[\w/-]+:)*(?:text|border(?:-[xytrblse])?|bg|outline|decoration)-ui-/.test(name) &&
      !/-ui-(?:xs|sm|md|base|lg|title)$/.test(name),
  );
}

/** The colour classes of an element and of everything inside it. */
export function colourClassesWithin(element: Element): string[] {
  return [element, ...Array.from(element.querySelectorAll('*'))].flatMap(colourClasses);
}

/** Your bubble's own colours, the only ones that read on it in every theme (accesibilidad.md §3.2). */
export const BUBBLE_ME_COLOUR = /(?:^|:)(?:text|border|bg)-ui-bubble-me(?:-ink|-muted|-line)?$/;
