// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectLang, type Lang } from './i18n';
import { LangCtx, useDocumentLang, useLang } from './i18n-context';

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html().setAttribute('lang', 'en'); // what index.html ships
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDocumentLang', () => {
  it('sets <html lang> on the first render and follows every change', () => {
    const { rerender } = renderHook(({ lang }: { lang: Lang }) => useDocumentLang(lang), {
      initialProps: { lang: 'es' },
    });
    expect(html().getAttribute('lang')).toBe('es');

    rerender({ lang: 'pt' });
    expect(html().getAttribute('lang')).toBe('pt');

    rerender({ lang: 'en' });
    expect(html().getAttribute('lang')).toBe('en');
  });
});

describe('<html lang> at start-up', () => {
  /** The same wiring as App: the detected language in state, mirrored on <html>. */
  function Root() {
    const [lang, setLang] = useState<Lang>(detectLang);
    useDocumentLang(lang);
    return (
      <button type="button" onClick={() => setLang('es')}>
        {lang}
      </button>
    );
  }

  it('starts with the saved language', () => {
    localStorage.setItem('lang', 'pt');
    render(<Root />);
    expect(html().getAttribute('lang')).toBe('pt');
  });

  it('starts with the first supported system language when nothing is saved', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'es-CO', 'en']);
    render(<Root />);
    expect(html().getAttribute('lang')).toBe('es');
  });

  it('follows the language when the user changes it', () => {
    localStorage.setItem('lang', 'en');
    render(<Root />);
    act(() => screen.getByRole('button').click());
    expect(html().getAttribute('lang')).toBe('es');
  });
});

describe('LangCtx', () => {
  it('gives useLang the language and the setter of its provider', () => {
    const setLang = vi.fn();
    const { result } = renderHook(() => useLang(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <LangCtx.Provider value={{ lang: 'pt', setLang }}>{children}</LangCtx.Provider>
      ),
    });
    expect(result.current.lang).toBe('pt');
    result.current.setLang('es');
    expect(setLang).toHaveBeenCalledWith('es');
  });

  it('defaults to English with a setter that does nothing, as it did in App.tsx', () => {
    const { result } = renderHook(() => useLang());
    expect(result.current.lang).toBe('en');
    expect(() => result.current.setLang('es')).not.toThrow();
  });
});
