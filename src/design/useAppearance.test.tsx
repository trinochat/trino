// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MORE_CONTRAST, SAFE_STATUS } from './a11y-tokens';
import { ACCESSIBILITY_STORAGE_KEY, DEFAULT_ACCESSIBILITY, type Accessibility } from './accessibility';
import { holdAccessibility, holdAppearance, holdScanLines, initAppearance, type AppearanceHost } from './apply';
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, type Appearance } from './appearance';
import { ACCENT_PALETTES, THEMES } from './tokens';
import { AppearanceProvider, useAccessibility, useAppearance } from './useAppearance';

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
    // Each query answers on its own, as with a real matchMedia: the colour
    // scheme switches, while contrast, motion and forced colours stay off.
    matchMedia: media => (media === query.media ? query : quietQuery(media)) as unknown as MediaQueryList,
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

/** A system query that never matches and never changes. */
function quietQuery(media: string) {
  return { matches: false, media, addEventListener: () => {}, removeEventListener: () => {} };
}

/* Accessibility (accesibilidad.md §2.3): the same provider holds it. */

type Signal = 'dark' | 'moreContrast' | 'reducedMotion';

const SIGNAL_QUERIES: Record<Signal, string> = {
  dark: '(prefers-color-scheme: dark)',
  moreContrast: '(prefers-contrast: more)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
};

/** A window stand-in with switchable system queries and storage that can refuse writes. */
function fakeSystem(entries: Record<string, string> = {}, { refuseWrites = false } = {}) {
  const data = new Map(Object.entries(entries));
  const storage = { refuseWrites };
  const queries = new Map(
    (Object.keys(SIGNAL_QUERIES) as Signal[]).map(signal => {
      const listeners = new Set<() => void>();
      const query = {
        matches: false,
        media: SIGNAL_QUERIES[signal],
        listeners,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      };
      return [SIGNAL_QUERIES[signal], query] as const;
    }),
  );
  const host: AppearanceHost = {
    document,
    localStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => {
        if (storage.refuseWrites) throw new Error('QuotaExceededError');
        data.set(key, value);
      },
    },
    matchMedia: media => (queries.get(media) ?? quietQuery(media)) as unknown as MediaQueryList,
  };
  const set = (signal: Signal, on: boolean) => {
    const query = queries.get(SIGNAL_QUERIES[signal])!;
    query.matches = on;
    query.listeners.forEach(listener => listener());
  };
  const listening = () => [...queries.values()].reduce((sum, query) => sum + query.listeners.size, 0);
  return { host, data, set, listening };
}

describe('useAccessibility', () => {
  beforeEach(() => {
    for (const attribute of ['data-vision', 'data-contrast', 'data-motion', 'data-spacing']) root().removeAttribute(attribute);
    holdAccessibility(document, null);
    holdScanLines(document, null);
  });

  it('needs the provider above it', () => {
    expect(() => renderHook(() => useAccessibility())).toThrow(/AppearanceProvider/);
  });

  it('starts with the stored settings, what they come to, and what the system says', () => {
    const value: Accessibility = { ...DEFAULT_ACCESSIBILITY, vision: 'safe', spacing: 'wide' };
    const { host } = fakeSystem({ [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify(value) });
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(host) });
    expect(result.current.accessibility).toEqual(value);
    expect(result.current.effective).toEqual({
      textScale: 1,
      vision: 'safe',
      contrast: 'standard',
      motion: 'full',
      spacing: 'wide',
    });
    expect(result.current.system).toEqual({ textScale: 1, moreContrast: false, reducedMotion: false, forcedColors: false });
    expect(result.current.scanLines).toBe(true);
  });

  it('saves a change and applies it at once, keeping the other settings and the appearance', () => {
    const { host, data } = fakeSystem({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ style: 'calma', mode: 'dark', accent: 'azul' }),
    });
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(host) });
    let saved = false;
    act(() => {
      saved = result.current.set({ vision: 'safe', textScale: 1.25 });
    });
    expect(saved).toBe(true);
    expect(JSON.parse(data.get(ACCESSIBILITY_STORAGE_KEY)!)).toEqual({
      ...DEFAULT_ACCESSIBILITY,
      vision: 'safe',
      textScale: 1.25,
    });
    expect(result.current.accessibility.vision).toBe('safe');
    expect(root().dataset.vision).toBe('safe');
    expect(root().style.fontSize).toBe('20px');
    expect(root().style.getPropertyValue('--t-ok')).toBe(SAFE_STATUS.dark.standard.ok);
    expect(root().style.getPropertyValue('--t-accent')).toBe(ACCENT_PALETTES.dark.azul.accent);
  });

  it('resets every setting to the defaults', () => {
    const { host, data } = fakeSystem({
      [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_ACCESSIBILITY, contrast: 'more', motion: 'reduce' }),
    });
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(host) });
    act(() => {
      result.current.reset();
    });
    expect(result.current.accessibility).toEqual(DEFAULT_ACCESSIBILITY);
    expect(JSON.parse(data.get(ACCESSIBILITY_STORAGE_KEY)!)).toEqual(DEFAULT_ACCESSIBILITY);
    expect(root().dataset.contrast).toBe('standard');
  });

  it('applies a change storage refuses for this session, through system changes too, and says so', () => {
    const { host, set } = fakeSystem({}, { refuseWrites: true });
    const stop = initAppearance(host);
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(host) });
    let saved = true;
    act(() => {
      saved = result.current.set({ vision: 'safe' });
    });
    expect(saved).toBe(false);
    expect(result.current.accessibility.vision).toBe('safe');
    act(() => set('dark', true));
    expect(root().dataset.vision).toBe('safe');
    stop();
  });

  it('switches the scan lines of Terminal dark live and stores the choice', () => {
    const { host, data } = fakeSystem({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ style: 'terminal', mode: 'dark', accent: 'verde' }),
    });
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(host) });
    act(() => {
      result.current.setScanLines(false);
    });
    expect(result.current.scanLines).toBe(false);
    expect(data.get('trino.pref.scanLines')).toBe('0');
    expect(root().style.getPropertyValue('--t-scan')).toBe('none');
    act(() => {
      result.current.setScanLines(true);
    });
    expect(root().style.getPropertyValue('--t-scan')).toBe(THEMES['terminal-dark'].scan);
  });

  it('keeps the accessibility layers when the appearance changes', () => {
    const { host } = fakeSystem({
      [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_ACCESSIBILITY, vision: 'safe', contrast: 'more' }),
    });
    const { result } = renderHook(() => ({ appearance: useAppearance(), accessibility: useAccessibility() }), {
      wrapper: wrapperFor(host),
    });
    act(() => {
      result.current.appearance.setAppearance({ style: 'terminal', mode: 'light', accent: 'verde' });
    });
    expect(root().style.getPropertyValue('--t-ok')).toBe(SAFE_STATUS.light.more.ok);
    expect(root().style.getPropertyValue('--t-muted')).toBe(MORE_CONTRAST['terminal-light'].muted);
  });

  // initAppearance stays the one owner of the matchMedia listeners; the
  // provider hears of its refreshes and reads the system again.
  it('follows what the system says through initAppearance, without a listener of its own', () => {
    const { host, set, listening } = fakeSystem();
    const stop = initAppearance(host);
    const before = listening();
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(host) });
    expect(listening()).toBe(before);
    act(() => set('reducedMotion', true));
    expect(result.current.system.reducedMotion).toBe(true);
    expect(result.current.effective.motion).toBe('reduce');
    stop();
  });
});

describe('useAccessibility and the text size shortcuts', () => {
  beforeEach(() => {
    root().removeAttribute('style');
    holdAccessibility(document, null);
  });

  // W2 takes the root size from here, so a shortcut has to reach it.
  it('hears a size changed with Ctrl + +, which initAppearance handles', () => {
    const { host } = fakeSystem();
    const target = new EventTarget();
    const windowLike: AppearanceHost = {
      ...host,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    };
    const stop = initAppearance(windowLike);
    const { result } = renderHook(() => useAccessibility(), { wrapper: wrapperFor(windowLike) });
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true }));
    });
    expect(result.current.accessibility.textScale).toBe(1.1);
    expect(result.current.effective.textScale).toBe(1.1);
    expect(root().style.fontSize).toBe('17.6px');
    stop();
  });
});
