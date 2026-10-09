import { createContext, useContext, useLayoutEffect } from 'react';
import type { Lang } from './i18n';

// Lets the Settings modal change the active language + re-render the whole app.
// App owns the state and provides it; screens read it with `useLang`.
export const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'en',
  setLang: () => {},
});

export function useLang(): { lang: Lang; setLang: (l: Lang) => void } {
  return useContext(LangCtx);
}

/**
 * Mirrors the current language on `<html lang>`, so screen readers, hyphenation
 * and fonts follow it. A layout effect sets it before the first paint.
 */
export function useDocumentLang(lang: Lang): void {
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
}
