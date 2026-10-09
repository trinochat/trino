// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME, type ThemePreference } from './theme';
import { ThemeCtx, useThemePreference } from './theme-context';

afterEach(cleanup);

describe('ThemeCtx', () => {
  it('gives useThemePreference the theme and the setter of its provider', () => {
    const theme: ThemePreference = { preset: 'corporate', accent: '#55a7f1' };
    const setTheme = vi.fn();
    const { result } = renderHook(() => useThemePreference(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>
      ),
    });
    expect(result.current.theme).toBe(theme);
    result.current.setTheme(DEFAULT_THEME);
    expect(setTheme).toHaveBeenCalledWith(DEFAULT_THEME);
  });

  it('defaults to the stored theme with a setter that does nothing, as it did in App.tsx', () => {
    // jsdom starts with empty storage, so the stored theme is the default one.
    const { result } = renderHook(() => useThemePreference());
    expect(result.current.theme).toEqual(DEFAULT_THEME);
    expect(() => result.current.setTheme(DEFAULT_THEME)).not.toThrow();
  });
});
