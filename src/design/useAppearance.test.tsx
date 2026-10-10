// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdAppearance, initAppearance, type AppearanceHost } from './apply';
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, type Appearance } from './appearance';
import { THEMES } from './tokens';
import { AppearanceProvider, useAppearance } from './useAppearance';

const root = () => document.documentElement;

/** A window stand-in whose system colour scheme and storage the test controls. */
function fakeHost(stored: Appearance | null, systemDark: boolean, { refuseWrites = false } = {}) {
  const data = new Map<string, string>();
  if (stored) data.set(APPEARANCE_STORAGE_KEY, JSON.stringify(stored));
  const storage = { refuseWrites };
  const listeners = new Set<() => void>();
  const query = {
    matches: systemDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const host: AppearanceHost = {
    document,
    localStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => {
        if (storage.refuseWrites) throw new Error('QuotaExceededError');
        data.set(key, value);
      },
    },
    matchMedia: () => query as unknown as MediaQueryList,
  };
  const setSystemDark = (dark: boolean) => {
    query.matches = dark;
    listeners.forEach(listener => listener());
  };
  const setRefuseWrites = (refuse: boolean) => {
    storage.refuseWrites = refuse;
  };
  return { host, data, listeners, setSystemDark, setRefuseWrites };
}

function wrapperFor(host: AppearanceHost) {
  return ({ children }: { children: ReactNode }) => <AppearanceProvider host={host}>{children}</AppearanceProvider>;
}

beforeEach(() => {
  for (const attribute of ['style', 'data-style', 'data-mode']) root().removeAttribute(attribute);
  holdAppearance(document, null);
});

afterEach(cleanup);

describe('AppearanceProvider and useAppearance', () => {
  it('start with the stored appearance, or the default without one', () => {
    const stored: Appearance = { style: 'terminal', mode: 'dark', accent: 'azul' };
    const { result } = renderHook(() => useAppearance(), { wrapper: wrapperFor(fakeHost(stored, false).host) });
    expect(result.current.appearance).toEqual(stored);

    const fresh = renderHook(() => useAppearance(), { wrapper: wrapperFor(fakeHost(null, false).host) });
    expect(fresh.result.current.appearance).toEqual(DEFAULT_APPEARANCE);
  });

  it('save a new appearance, apply it at once and show it to every reader', () => {
    const { host, data } = fakeHost(null, false);
    function Reader() {
      const { appearance } = useAppearance();
      return <p>{`${appearance.style} ${appearance.mode} ${appearance.accent}`}</p>;
    }
    function Picker() {
      const { setAppearance } = useAppearance();
      return (
        <button type="button" onClick={() => setAppearance({ style: 'terminal', mode: 'dark', accent: 'morado' })}>
          change
        </button>
      );
    }
    render(
      <AppearanceProvider host={host}>
        <Reader />
        <Picker />
      </AppearanceProvider>,
    );
    expect(screen.getByText('calma light verde')).toBeTruthy();

    act(() => screen.getByRole('button').click());

    expect(screen.getByText('terminal dark morado')).toBeTruthy();
    expect(JSON.parse(data.get(APPEARANCE_STORAGE_KEY)!)).toEqual({ style: 'terminal', mode: 'dark', accent: 'morado' });
    expect(root().dataset.style).toBe('terminal');
    expect(root().dataset.mode).toBe('dark');
    expect(root().style.getPropertyValue('--t-bg')).toBe(THEMES['terminal-dark'].bg);
  });

  it('resolve the system mode with the current colour scheme', () => {
    const { host } = fakeHost(null, true);
    const { result } = renderHook(() => useAppearance(), { wrapper: wrapperFor(host) });
    act(() => {
      result.current.setAppearance({ style: 'calma', mode: 'system', accent: 'verde' });
    });
    expect(result.current.appearance.mode).toBe('system');
    expect(root().dataset.mode).toBe('dark');
  });

  // One owner for the prefers-color-scheme listener: initAppearance, started
  // in main.tsx before the first render. It reads the stored appearance on
  // every change, so what the provider saves is what it follows.
  it('leave the colour scheme listener to initAppearance, which follows what they save', () => {
    const { host, listeners, setSystemDark } = fakeHost(null, false);
    const stop = initAppearance(host);
    expect(listeners.size).toBe(1);

    const { result } = renderHook(() => useAppearance(), { wrapper: wrapperFor(host) });
    act(() => {
      result.current.setAppearance({ style: 'calma', mode: 'system', accent: 'verde' });
    });
    expect(listeners.size).toBe(1);
    expect(root().dataset.mode).toBe('light');

    setSystemDark(true);
    expect(root().dataset.mode).toBe('dark');

    act(() => {
      result.current.setAppearance({ style: 'calma', mode: 'light', accent: 'verde' });
    });
    setSystemDark(false);
    setSystemDark(true);
    expect(root().dataset.mode).toBe('light');
    stop();
  });

  it('still apply the appearance for this session when storage refuses it, and say so', () => {
    const { host } = fakeHost(null, false, { refuseWrites: true });
    const { result } = renderHook(() => useAppearance(), { wrapper: wrapperFor(host) });
    let saved = true;
    act(() => {
      saved = result.current.setAppearance({ style: 'terminal', mode: 'light', accent: 'verde' });
    });
    expect(saved).toBe(false);
    expect(result.current.appearance.style).toBe('terminal');
    expect(root().dataset.style).toBe('terminal');
  });

  // The listener of initAppearance would otherwise re-apply what storage
  // still holds, over the appearance the user just chose.
  it('keep an appearance storage refused when the system colour scheme changes', () => {
    const stored: Appearance = { style: 'calma', mode: 'system', accent: 'verde' };
    const { host, setSystemDark } = fakeHost(stored, false, { refuseWrites: true });
    const stop = initAppearance(host);
    const { result } = renderHook(() => useAppearance(), { wrapper: wrapperFor(host) });

    act(() => {
      result.current.setAppearance({ style: 'terminal', mode: 'system', accent: 'azul' });
    });
    setSystemDark(true);
    expect(root().dataset.style).toBe('terminal');
    expect(root().dataset.mode).toBe('dark');

    act(() => {
      result.current.setAppearance({ style: 'terminal', mode: 'light', accent: 'azul' });
    });
    setSystemDark(false);
    setSystemDark(true);
    expect(root().dataset.mode).toBe('light');
    stop();
  });

  it('let storage lead again once it takes a save', () => {
    const { host, data, setSystemDark, setRefuseWrites } = fakeHost(null, false, { refuseWrites: true });
    const stop = initAppearance(host);
    const { result } = renderHook(() => useAppearance(), { wrapper: wrapperFor(host) });
    act(() => {
      result.current.setAppearance({ style: 'terminal', mode: 'light', accent: 'azul' });
    });

    setRefuseWrites(false);
    let saved = false;
    act(() => {
      saved = result.current.setAppearance({ style: 'calma', mode: 'system', accent: 'verde' });
    });
    expect(saved).toBe(true);
    // Saved after start-up by someone else, as apply.test.ts allows.
    data.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ style: 'terminal', mode: 'system', accent: 'verde' }));
    setSystemDark(true);
    expect(root().dataset.style).toBe('terminal');
    expect(root().dataset.mode).toBe('dark');
    stop();
  });

  it('need the provider above them', () => {
    expect(() => renderHook(() => useAppearance())).toThrow(/AppearanceProvider/);
  });
});
