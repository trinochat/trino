// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAppearance, holdAppearance, initAppearance, type AppearanceHost } from './apply';
import { APPEARANCE_STORAGE_KEY, type Appearance } from './appearance';
import { ACCENT_PALETTES, THEMES } from './tokens';

const root = () => document.documentElement;
const variable = (name: string) => root().style.getPropertyValue(name);

function resetRoot() {
  for (const attribute of ['style', 'data-style', 'data-mode', 'data-theme']) {
    root().removeAttribute(attribute);
  }
  holdAppearance(document, null);
}

/** A window stand-in whose system colour scheme the test can switch. */
function fakeHost(stored: Appearance | null, systemDark: boolean) {
  const data = new Map<string, string>();
  if (stored) data.set(APPEARANCE_STORAGE_KEY, JSON.stringify(stored));
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
        data.set(key, value);
      },
    },
    matchMedia: () => query as unknown as MediaQueryList,
  };
  const setSystemDark = (dark: boolean) => {
    query.matches = dark;
    listeners.forEach(listener => listener());
  };
  return { host, data, listeners, setSystemDark };
}

describe('applyAppearance', () => {
  beforeEach(resetRoot);

  it('sets the tokens as CSS variables on the root element', () => {
    applyAppearance(document, { style: 'calma', mode: 'light', accent: 'verde' }, false);
    expect(variable('--t-bg')).toBe('#F5F7F6');
    expect(variable('--t-accent')).toBe('#0F7B4A');
    expect(variable('--t-font')).toBe(THEMES['calma-light'].font);
    expect(variable('--t-scan')).toBe('none');
  });

  it('marks the root with data-style and the resolved data-mode', () => {
    applyAppearance(document, { style: 'terminal', mode: 'system', accent: 'verde' }, true);
    expect(root().dataset.style).toBe('terminal');
    expect(root().dataset.mode).toBe('dark');
    expect(variable('--t-bg')).toBe(THEMES['terminal-dark'].bg);
    expect(variable('--t-scan')).toBe(THEMES['terminal-dark'].scan);
  });

  it('carries an alternative accent into the bubble variables', () => {
    applyAppearance(document, { style: 'calma', mode: 'dark', accent: 'naranja' }, false);
    expect(variable('--t-bubble-me')).toBe(ACCENT_PALETTES.dark.naranja.bubbleMe);
    expect(variable('--t-accent')).toBe(ACCENT_PALETTES.dark.naranja.accent);
    expect(variable('--t-danger')).toBe(THEMES['calma-dark'].danger);
  });

  it('sets the boundary of the text fields, which no accent changes', () => {
    applyAppearance(document, { style: 'terminal', mode: 'light', accent: 'azul' }, false);
    expect(variable('--t-control-line')).toBe(THEMES['terminal-light'].controlLine);
  });

  it('replaces every variable of the previous appearance', () => {
    applyAppearance(document, { style: 'terminal', mode: 'dark', accent: 'azul' }, false);
    applyAppearance(document, { style: 'calma', mode: 'light', accent: 'verde' }, false);
    expect(variable('--t-bg')).toBe(THEMES['calma-light'].bg);
    expect(variable('--t-accent')).toBe(THEMES['calma-light'].accent);
    expect(variable('--t-radius')).toBe(THEMES['calma-light'].radius);
    expect(root().dataset.mode).toBe('light');
  });

  it('leaves the legacy theme alone, so the current screens keep working', () => {
    root().dataset.theme = 'trino';
    root().style.setProperty('--color-accent', '34 255 102');
    applyAppearance(document, { style: 'calma', mode: 'light', accent: 'verde' }, false);
    expect(root().dataset.theme).toBe('trino');
    expect(variable('--color-accent')).toBe('34 255 102');
  });

  it.each([
    ['light', false, 'light'],
    ['dark', false, 'dark'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
  ] as const)(
    'gives native controls the %s mode (system dark: %s) through --t-color-scheme: %s',
    (mode, prefersDark, scheme) => {
      applyAppearance(document, { style: 'terminal', mode, accent: 'verde' }, prefersDark);
      expect(variable('--t-color-scheme')).toBe(scheme);
    },
  );

  it('leaves color-scheme on <html> unset, so the legacy screens keep their native controls', () => {
    applyAppearance(document, { style: 'calma', mode: 'dark', accent: 'verde' }, false);
    expect(root().style.getPropertyValue('color-scheme')).toBe('');
  });
});

describe('initAppearance', () => {
  beforeEach(resetRoot);

  it('applies the stored appearance straight away', () => {
    const { host } = fakeHost({ style: 'terminal', mode: 'light', accent: 'morado' }, true);
    initAppearance(host);
    expect(root().dataset.style).toBe('terminal');
    expect(root().dataset.mode).toBe('light');
    expect(variable('--t-accent')).toBe(ACCENT_PALETTES.light.morado.accent);
  });

  it('applies the defaults when nothing is stored', () => {
    const { host } = fakeHost(null, true);
    initAppearance(host);
    expect(root().dataset.style).toBe('calma');
    expect(root().dataset.mode).toBe('light');
    expect(variable('--t-bg')).toBe(THEMES['calma-light'].bg);
  });

  it('follows the system colour scheme while the mode is system', () => {
    const { host, setSystemDark } = fakeHost({ style: 'calma', mode: 'system', accent: 'verde' }, false);
    initAppearance(host);
    expect(root().dataset.mode).toBe('light');
    setSystemDark(true);
    expect(root().dataset.mode).toBe('dark');
    expect(variable('--t-bg')).toBe(THEMES['calma-dark'].bg);
    expect(variable('--t-color-scheme')).toBe('dark');
  });

  it('ignores the system colour scheme while the mode is explicit', () => {
    const { host, setSystemDark } = fakeHost({ style: 'calma', mode: 'light', accent: 'verde' }, false);
    initAppearance(host);
    setSystemDark(true);
    expect(root().dataset.mode).toBe('light');
    expect(variable('--t-bg')).toBe(THEMES['calma-light'].bg);
  });

  it('uses the appearance saved after start-up when the system changes', () => {
    const { host, data, setSystemDark } = fakeHost({ style: 'terminal', mode: 'dark', accent: 'verde' }, true);
    initAppearance(host);
    data.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ style: 'terminal', mode: 'system', accent: 'azul' }));
    setSystemDark(false);
    expect(root().dataset.mode).toBe('light');
    expect(variable('--t-accent')).toBe(ACCENT_PALETTES.light.azul.accent);
  });

  // The provider holds an appearance that storage refused (useAppearance.ts):
  // it applies until the app closes, through scheme changes too.
  it('follows the appearance held for this session rather than the stored one', () => {
    const { host, setSystemDark } = fakeHost({ style: 'calma', mode: 'system', accent: 'verde' }, false);
    initAppearance(host);
    holdAppearance(document, { style: 'terminal', mode: 'system', accent: 'azul' });
    setSystemDark(true);
    expect(root().dataset.style).toBe('terminal');
    expect(root().dataset.mode).toBe('dark');
    expect(variable('--t-accent')).toBe(ACCENT_PALETTES.dark.azul.accent);

    // As the provider does: hold it and apply it.
    const light: Appearance = { style: 'terminal', mode: 'light', accent: 'azul' };
    holdAppearance(document, light);
    applyAppearance(document, light, true);
    setSystemDark(false);
    setSystemDark(true);
    expect(root().dataset.mode).toBe('light');
  });

  it('lets the stored appearance lead again once the hold is released', () => {
    const { host, setSystemDark } = fakeHost({ style: 'calma', mode: 'system', accent: 'verde' }, false);
    initAppearance(host);
    holdAppearance(document, { style: 'terminal', mode: 'light', accent: 'azul' });
    holdAppearance(document, null);
    setSystemDark(true);
    expect(root().dataset.style).toBe('calma');
    expect(root().dataset.mode).toBe('dark');
  });

  it('stops listening once disposed', () => {
    const { host, listeners } = fakeHost({ style: 'calma', mode: 'system', accent: 'verde' }, false);
    const dispose = initAppearance(host);
    expect(listeners.size).toBe(1);
    dispose();
    expect(listeners.size).toBe(0);
  });

  it('uses the older addListener API where addEventListener is missing', () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: false,
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    };
    const { host } = fakeHost({ style: 'calma', mode: 'system', accent: 'verde' }, false);
    const dispose = initAppearance({ ...host, matchMedia: () => query as unknown as MediaQueryList });
    query.matches = true;
    listeners.forEach(listener => listener());
    expect(root().dataset.mode).toBe('dark');
    dispose();
    expect(listeners.size).toBe(0);
  });

  it('starts light, without throwing, when storage and matchMedia are unavailable', () => {
    const host: AppearanceHost = {
      document,
      get localStorage(): AppearanceHost['localStorage'] {
        throw new Error('SecurityError');
      },
    };
    expect(() => initAppearance(host)()).not.toThrow();
    expect(root().dataset.style).toBe('calma');
    expect(root().dataset.mode).toBe('light');
  });
});
