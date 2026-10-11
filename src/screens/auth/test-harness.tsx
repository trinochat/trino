/**
 * What the auth screens need around them in the tests: the texts, in a
 * language the screen can change (LangCtx and I18nContext, as the app
 * provides them), and the appearance, on a stand-in for `window`. Not part of
 * the app: only test files import this module.
 */
import { render, type RenderResult } from '@testing-library/react';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { AppearanceHost } from '../../design/apply';
import { AppearanceProvider } from '../../design/useAppearance';
import { I18nContext, makeT, type Lang } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';

/** A `window` stand-in: storage in a map, and a system that asks for nothing (light, standard). */
export function fakeAppearanceHost(): { host: AppearanceHost; data: Map<string, string> } {
  const data = new Map<string, string>();
  const quiet = (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
  return {
    data,
    host: {
      document,
      localStorage: {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => {
          data.set(key, value);
        },
      },
      matchMedia: media => quiet(media) as unknown as MediaQueryList,
    },
  };
}

/** What the appearance leaves on <html>, removed between tests. */
export function resetDocument(): void {
  const root = document.documentElement;
  for (const attribute of ['style', 'lang', 'data-style', 'data-mode', 'data-vision', 'data-contrast', 'data-motion', 'data-spacing']) {
    root.removeAttribute(attribute);
  }
}

export interface AuthProvidersProps {
  children?: ReactNode;
  lang?: Lang;
  host?: AppearanceHost;
}

export function AuthProviders({ children, lang: initial = 'es', host }: AuthProvidersProps) {
  const [lang, setLang] = useState<Lang>(initial);
  const t = useMemo(() => makeT(lang), [lang]);
  const appearanceHost = useMemo(() => host ?? fakeAppearanceHost().host, [host]);
  return (
    <AppearanceProvider host={appearanceHost}>
      <LangCtx.Provider value={{ lang, setLang }}>
        <I18nContext.Provider value={t}>{children}</I18nContext.Provider>
      </LangCtx.Provider>
    </AppearanceProvider>
  );
}

export function renderAuth(ui: ReactElement, options: Omit<AuthProvidersProps, 'children'> = {}): RenderResult {
  return render(<AuthProviders {...options}>{ui}</AuthProviders>);
}

/** The classes of an element, as a list. */
export const classesOf = (element: Element | null): string[] => (element?.getAttribute('class') ?? '').split(/\s+/);
