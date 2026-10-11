/**
 * For the tests of the call and verification screens only: nothing in the
 * app imports this file. It renders a screen in a language of the app, with
 * the real texts, so a test reads what a person would.
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nContext, makeT, type Lang } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';

export function renderIn(node: ReactNode, lang: Lang = 'es'): RenderResult {
  const t = makeT(lang);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <I18nContext.Provider value={t}>
      <LangCtx.Provider value={{ lang, setLang: () => {} }}>{children}</LangCtx.Provider>
    </I18nContext.Provider>
  );
  return render(node, { wrapper: Wrapper });
}

/** A `localStorage` that counts every access, to show that a path never touches the preferences. */
export function countingStorage(): { storage: Storage; accesses: string[] } {
  const accesses: string[] = [];
  const data = new Map<string, string>();
  const storage = {
    get length() {
      accesses.push('length');
      return data.size;
    },
    key: (i: number) => {
      accesses.push(`key:${i}`);
      return [...data.keys()][i] ?? null;
    },
    getItem: (key: string) => {
      accesses.push(`get:${key}`);
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      accesses.push(`set:${key}`);
      data.set(key, value);
    },
    removeItem: (key: string) => {
      accesses.push(`remove:${key}`);
      data.delete(key);
    },
    clear: () => {
      accesses.push('clear');
      data.clear();
    },
  } as Storage;
  return { storage, accesses };
}
