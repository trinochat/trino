// @vitest-environment jsdom
// @ts-expect-error Node's types are not installed; vitest runs the tests on Node.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { MORE_CONTRAST, SAFE_STATUS } from './a11y-tokens';
import {
  ACCESSIBILITY_STORAGE_KEY,
  DEFAULT_ACCESSIBILITY,
  LEGACY_TEXT_SIZE_STORAGE_KEY,
  SYSTEM_TEXT_SCALE_STORAGE_KEY,
  type Accessibility,
  type EffectiveAccessibility,
} from './accessibility';
import {
  applyAccessibility,
  applyAppearance,
  holdAccessibility,
  holdAppearance,
  holdScanLines,
  initAppearance,
  prefersReducedMotion,
  refreshAppearance,
  systemSignals,
  watchAppearance,
  type AppearanceHost,
} from './apply';
import { APPEARANCE_STORAGE_KEY, type Appearance } from './appearance';
import { ACCENT_PALETTES, THEMES } from './tokens';

const root = () => document.documentElement;
const variable = (name: string) => root().style.getPropertyValue(name);

function resetRoot() {
  for (const attribute of ['style', 'data-style', 'data-mode']) {
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
    // Each query answers on its own, as with a real matchMedia: the colour
    // scheme switches, while contrast, motion and forced colours stay off.
    matchMedia: media => (media === query.media ? query : quietQuery(media)) as unknown as MediaQueryList,
  };
  const setSystemDark = (dark: boolean) => {
    query.matches = dark;
    listeners.forEach(listener => listener());
  };
  return { host, data, listeners, setSystemDark };
}

/** A system query that never matches and never changes. */
function quietQuery(media: string) {
  return { matches: false, media, addEventListener: () => {}, removeEventListener: () => {} };
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

  // Each control applies the mode itself (COLOR_SCHEME in src/ui/controls/styles.ts).
  it('leaves color-scheme on <html> unset', () => {
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

  // One fake per query, each keeping its own calls: a query that is never
  // released cannot hide behind another that is, and only the colour scheme
  // changes.
  it('uses the older addListener API where addEventListener is missing', () => {
    const queries = new Map<string, { matches: boolean; added: (() => void)[]; removed: (() => void)[] }>();
    const matchMedia = (media: string) => {
      const query = queries.get(media) ?? { matches: false, added: [], removed: [] };
      queries.set(media, query);
      return {
        get matches() {
          return query.matches;
        },
        media,
        addListener: (listener: () => void) => query.added.push(listener),
        removeListener: (listener: () => void) => query.removed.push(listener),
      } as unknown as MediaQueryList;
    };
    const calls = () => Object.fromEntries([...queries].map(([media, query]) => [media, [query.added.length, query.removed.length]]));
    const { host } = fakeHost({ style: 'calma', mode: 'system', accent: 'verde' }, false);
    const dispose = initAppearance({ ...host, matchMedia });
    expect(calls()).toEqual({
      '(prefers-color-scheme: dark)': [1, 0],
      '(prefers-contrast: more)': [1, 0],
      '(prefers-reduced-motion: reduce)': [1, 0],
      '(forced-colors: active)': [1, 0],
    });

    const scheme = queries.get('(prefers-color-scheme: dark)')!;
    scheme.matches = true;
    scheme.added.forEach(listener => listener());
    expect(root().dataset.mode).toBe('dark');
    expect(root().dataset.contrast).toBe('standard');

    dispose();
    expect(Object.values(calls())).toEqual(Array(4).fill([1, 1]));
    // Each query lets go of the very listener it was given.
    for (const query of queries.values()) expect(query.removed).toEqual(query.added);
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

/* Accessibility (accesibilidad.md §2.3, §4.5): the settings and the system signals. */

type Signal = 'dark' | 'moreContrast' | 'reducedMotion' | 'forcedColors';

const SIGNAL_QUERIES: Record<Signal, string> = {
  dark: '(prefers-color-scheme: dark)',
  moreContrast: '(prefers-contrast: more)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
  forcedColors: '(forced-colors: active)',
};

/** A window stand-in with storage and the four system queries, each switchable. */
function fakeSystem(entries: Record<string, string> = {}, signals: Partial<Record<Signal, boolean>> = {}) {
  const data = new Map(Object.entries(entries));
  const queries = new Map(
    (Object.keys(SIGNAL_QUERIES) as Signal[]).map(signal => {
      const listeners = new Set<() => void>();
      const query = {
        matches: signals[signal] ?? false,
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
  const listening = (signal: Signal) => queries.get(SIGNAL_QUERIES[signal])!.listeners.size;
  return { host, data, set, listening };
}

const a11yEntry = (value: Partial<Accessibility>) => ({
  [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_ACCESSIBILITY, ...value }),
});

function resetAccessibility() {
  resetRoot();
  for (const attribute of ['data-vision', 'data-contrast', 'data-motion', 'data-spacing']) {
    root().removeAttribute(attribute);
  }
  holdAccessibility(document, null);
  holdScanLines(document, null);
}

const STANDARD_EFFECTIVE: EffectiveAccessibility = {
  textScale: 1,
  vision: 'standard',
  contrast: 'standard',
  motion: 'full',
  spacing: 'standard',
};

describe('applyAccessibility', () => {
  beforeEach(resetAccessibility);

  it('marks <html> with the vision, contrast, motion and spacing in effect', () => {
    applyAccessibility(document, { textScale: 1, vision: 'safe', contrast: 'more', motion: 'reduce', spacing: 'wide' });
    expect({ ...root().dataset }).toMatchObject({ vision: 'safe', contrast: 'more', motion: 'reduce', spacing: 'wide' });
    applyAccessibility(document, STANDARD_EFFECTIVE);
    expect({ ...root().dataset }).toMatchObject({
      vision: 'standard',
      contrast: 'standard',
      motion: 'full',
      spacing: 'standard',
    });
  });

  // Everything in rem grows with the root: text, icons, targets and gaps.
  it.each([
    [1, '16px'],
    [1.25, '20px'],
    [1.35, '21.6px'],
    [2, '32px'],
  ])('sets the root font size to 16 px × %s', (textScale, size) => {
    applyAccessibility(document, { ...STANDARD_EFFECTIVE, textScale });
    expect(root().style.fontSize).toBe(size);
  });

  it('leaves the appearance alone', () => {
    applyAppearance(document, { style: 'terminal', mode: 'dark', accent: 'azul' }, false);
    applyAccessibility(document, { ...STANDARD_EFFECTIVE, vision: 'safe' });
    expect(root().dataset.style).toBe('terminal');
    expect(variable('--t-accent')).toBe(ACCENT_PALETTES.dark.azul.accent);
  });

  it('tells scripts whether to reduce motion, from data-motion', () => {
    applyAccessibility(document, { ...STANDARD_EFFECTIVE, motion: 'reduce' });
    expect(prefersReducedMotion(document)).toBe(true);
    applyAccessibility(document, STANDARD_EFFECTIVE);
    expect(prefersReducedMotion(document)).toBe(false);
  });
});

describe('applyAppearance with the accessibility layers', () => {
  beforeEach(resetAccessibility);

  it('passes the vision and the contrast to the tokens', () => {
    applyAppearance(document, { style: 'calma', mode: 'light', accent: 'verde' }, false, {
      vision: 'safe',
      contrast: 'more',
    });
    expect(variable('--t-ok')).toBe(SAFE_STATUS.light.more.ok);
    expect(variable('--t-muted')).toBe(MORE_CONTRAST['calma-light'].muted);
  });

  it('drops the scan lines when their switch is off', () => {
    applyAppearance(document, { style: 'terminal', mode: 'dark', accent: 'verde' }, false, {
      vision: 'standard',
      contrast: 'standard',
      scanLines: false,
    });
    expect(variable('--t-scan')).toBe('none');
  });
});

describe('initAppearance with the accessibility settings', () => {
  beforeEach(resetAccessibility);

  it('applies the stored settings before the first render', () => {
    const { host } = fakeSystem({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ style: 'calma', mode: 'dark', accent: 'verde' }),
      ...a11yEntry({ textScale: 1.5, vision: 'safe', contrast: 'more', motion: 'reduce', spacing: 'wide' }),
    });
    initAppearance(host);
    expect({ ...root().dataset }).toMatchObject({ vision: 'safe', contrast: 'more', motion: 'reduce', spacing: 'wide' });
    expect(root().style.fontSize).toBe('24px');
    expect(variable('--t-ok')).toBe(SAFE_STATUS.dark.more.ok);
    expect(variable('--t-muted')).toBe(MORE_CONTRAST['calma-dark'].muted);
  });

  it('starts at 16 px with everything standard when nothing is stored', () => {
    const { host } = fakeSystem();
    initAppearance(host);
    expect({ ...root().dataset }).toMatchObject({
      vision: 'standard',
      contrast: 'standard',
      motion: 'full',
      spacing: 'standard',
    });
    expect(root().style.fontSize).toBe('16px');
    expect(variable('--t-muted')).toBe(THEMES['calma-light'].muted);
  });

  it("migrates E0's large text size to 125 %", () => {
    const { host } = fakeSystem({ [LEGACY_TEXT_SIZE_STORAGE_KEY]: 'large' });
    initAppearance(host);
    expect(root().style.fontSize).toBe('20px');
  });

  it('follows the system contrast and motion while the settings say system', () => {
    const { host, set } = fakeSystem({}, { moreContrast: true });
    initAppearance(host);
    expect(root().dataset.contrast).toBe('more');
    expect(variable('--t-muted')).toBe(MORE_CONTRAST['calma-light'].muted);

    set('moreContrast', false);
    expect(root().dataset.contrast).toBe('standard');
    expect(variable('--t-muted')).toBe(THEMES['calma-light'].muted);

    set('reducedMotion', true);
    expect(root().dataset.motion).toBe('reduce');
  });

  it('keeps what the person chose when the system changes', () => {
    const { host, set } = fakeSystem(a11yEntry({ contrast: 'standard', motion: 'full' }));
    initAppearance(host);
    set('moreContrast', true);
    set('reducedMotion', true);
    expect(root().dataset.contrast).toBe('standard');
    expect(root().dataset.motion).toBe('full');
  });

  it('listens to prefers-contrast, prefers-reduced-motion and forced-colors, and stops once disposed', () => {
    const { host, listening } = fakeSystem();
    const all = () => (['dark', 'moreContrast', 'reducedMotion', 'forcedColors'] as const).map(listening);
    const dispose = initAppearance(host);
    expect(all()).toEqual([1, 1, 1, 1]);
    dispose();
    expect(all()).toEqual([0, 0, 0, 0]);
  });

  it('reads the settings saved after start-up when the system changes', () => {
    const { host, data, set } = fakeSystem();
    initAppearance(host);
    data.set(ACCESSIBILITY_STORAGE_KEY, JSON.stringify({ ...DEFAULT_ACCESSIBILITY, vision: 'safe' }));
    set('forcedColors', true);
    expect(root().dataset.vision).toBe('safe');
    expect(variable('--t-ok')).toBe(SAFE_STATUS.light.standard.ok);
  });

  it('follows the settings held for this session rather than the stored ones', () => {
    const { host, set } = fakeSystem(a11yEntry({ vision: 'standard' }));
    initAppearance(host);
    holdAccessibility(document, { ...DEFAULT_ACCESSIBILITY, vision: 'safe', textScale: 2 });
    set('reducedMotion', true);
    expect(root().dataset.vision).toBe('safe');
    expect(root().style.fontSize).toBe('32px');
    expect(root().dataset.motion).toBe('reduce');

    holdAccessibility(document, null);
    set('reducedMotion', false);
    expect(root().dataset.vision).toBe('standard');
    expect(root().style.fontSize).toBe('16px');
  });

  it('keeps the layers when the colour scheme changes', () => {
    const { host, set } = fakeSystem({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ style: 'terminal', mode: 'system', accent: 'verde' }),
      ...a11yEntry({ vision: 'safe' }),
    });
    initAppearance(host);
    set('dark', true);
    expect(root().dataset.mode).toBe('dark');
    expect(variable('--t-ok')).toBe(SAFE_STATUS.dark.standard.ok);
  });

  it("switches Terminal's scan lines off from the stored preference, or a held one", () => {
    const appearance = { [APPEARANCE_STORAGE_KEY]: JSON.stringify({ style: 'terminal', mode: 'dark', accent: 'verde' }) };
    const off = fakeSystem({ ...appearance, 'trino.pref.scanLines': '0' });
    initAppearance(off.host);
    expect(variable('--t-scan')).toBe('none');

    resetAccessibility();
    const on = fakeSystem(appearance);
    initAppearance(on.host);
    expect(variable('--t-scan')).toBe(THEMES['terminal-dark'].scan);
    holdScanLines(document, false);
    on.set('reducedMotion', true);
    expect(variable('--t-scan')).toBe('none');
  });

  it('starts at 16 px, without throwing, when storage and matchMedia are unavailable', () => {
    const host: AppearanceHost = {
      document,
      get localStorage(): AppearanceHost['localStorage'] {
        throw new Error('SecurityError');
      },
    };
    expect(() => initAppearance(host)()).not.toThrow();
    expect(root().style.fontSize).toBe('16px');
    expect(root().dataset.contrast).toBe('standard');
  });
});

describe('watchAppearance and systemSignals', () => {
  beforeEach(resetAccessibility);

  it('tell a watcher each time the page is refreshed, until it stops watching', () => {
    const { host, set } = fakeSystem();
    initAppearance(host);
    const seen: string[] = [];
    const stop = watchAppearance(document, () => seen.push(root().dataset.motion ?? ''));
    set('reducedMotion', true);
    refreshAppearance(host);
    stop();
    set('reducedMotion', false);
    expect(seen).toEqual(['reduce', 'reduce']);
  });

  it('read what the system says without listening to it', () => {
    const { host, listening } = fakeSystem({}, { moreContrast: true, forcedColors: true });
    expect(systemSignals(host)).toEqual({ textScale: 1, moreContrast: true, reducedMotion: false, forcedColors: true });
    expect(listening('moreContrast')).toBe(0);
  });
});

/**
 * The rules of base.css, without comments and with single spaces. Read from
 * disk, from the project root where vitest runs: vitest hands CSS imports to
 * tests empty, `?raw` included.
 */
const BASE_RULES = (readFileSync('src/design/base.css', 'utf8') as string)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();

describe('base.css', () => {
  it('puts the root at 16 px, for applyAccessibility to scale', () => {
    expect(BASE_RULES).toContain('html { font-size: 16px; }');
  });

  it('stops animations, transitions and smooth scrolling under data-motion="reduce"', () => {
    expect(BASE_RULES).toContain(
      ":root[data-motion='reduce'] *, :root[data-motion='reduce'] *::before, :root[data-motion='reduce'] *::after {",
    );
    for (const declaration of [
      'animation-duration: 0.01ms !important;',
      'animation-iteration-count: 1 !important;',
      'transition-duration: 0.01ms !important;',
      'scroll-behavior: auto !important;',
    ]) {
      expect(BASE_RULES).toContain(declaration);
    }
  });

  // Dialogs and toasts are portals in <body>, outside #root.
  it('widens the spacing of everything in <body>, dialogs and toasts included', () => {
    expect(BASE_RULES).toContain(
      ":root[data-spacing='wide'] :where(body *) { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }",
    );
    const spacing = BASE_RULES.match(/:root\[data-spacing='wide'\][^{]*\{[^}]*\}/g) ?? [];
    expect(spacing).toHaveLength(2);
    expect(spacing.filter(rule => rule.includes('#root'))).toEqual([]);
  });

  // A message bubble is a single <p>: 2 em after it would only push the time down.
  it('puts 2 em between paragraphs, never after the last one', () => {
    expect(BASE_RULES).toContain(
      ":root[data-spacing='wide'] :where(body p:not(:last-child)) { margin-block-end: 2em !important; }",
    );
  });

  // I7 brought the base rules of App.css here, on the redesign's tokens
  // (accesibilidad.md §5.1). App.css held Tailwind's layers too. Without
  // `@tailwind variants`, Tailwind appends the variants of the utilities at
  // the very end, after the motion and spacing rules.
  it("brings in Tailwind's layers, and adds its own rules to the base one", () => {
    expect(
      BASE_RULES.startsWith(
        '@tailwind base; @tailwind components; @tailwind utilities; @tailwind variants; @layer base {',
      ),
    ).toBe(true);
  });

  // accesibilidad.md §4.7, rule 9: the page never scrolls, so whatever can
  // grow (the chats, the messages, a section of Settings) scrolls on its own.
  it("fills the window with the theme's background, text colour and font, and never scrolls it", () => {
    expect(BASE_RULES).toContain(
      'html, body, #root { height: 100%; margin: 0; background: var(--t-bg); color: var(--t-ink); font-family: var(--t-font); overflow: hidden; }',
    );
  });

  // The status bar, a notch or the navigation bar of a phone; 0 on a computer.
  it("keeps the app out of a phone's safe areas", () => {
    expect(BASE_RULES).toContain(
      '#root { box-sizing: border-box; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }',
    );
  });

  // The thumb is in controlLine, which reaches 3:1 on every surface (tokens.ts),
  // as the boundary of a control should (WCAG 1.4.11); the track lets the
  // surface it scrolls show through.
  it('draws thin scrollbars whose thumb shows on every surface', () => {
    for (const rule of [
      '::-webkit-scrollbar { width: 6px; height: 6px; }',
      '::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }',
      '::-webkit-scrollbar-thumb { background: var(--t-control-line); border-radius: 2px; }',
      '::-webkit-scrollbar-thumb:hover { background: var(--t-muted); }',
    ]) {
      expect(BASE_RULES).toContain(rule);
    }
  });

  // The 14 px that App.css once gave the page made every rem smaller.
  it("sets no font size but the root's", () => {
    expect(BASE_RULES.match(/font-size/g)).toEqual(['font-size']);
  });

  // Its variables, its scan lines over the window, its focus glow and its
  // selection colours: the redesign has its own (tokens.ts, the shell's scan
  // lines, FOCUS_RING), and the system draws the selection.
  it('keeps nothing of the old theme', () => {
    expect(BASE_RULES).not.toMatch(/--color-|data-theme|--font-ui|body::before|:focus-visible|::selection/);
  });

  // accesibilidad.md §5.1: the rules that follow the accessibility settings
  // come after every other one, Tailwind's utilities included.
  it('keeps the motion and spacing rules last', () => {
    const start = BASE_RULES.indexOf(":root[data-motion='reduce']");
    expect(start).toBeGreaterThan(0);
    const selectors = BASE_RULES.slice(start)
      .split('}')
      .map(rule => rule.split('{')[0]!.trim())
      .filter(Boolean);
    expect(selectors).toEqual([
      ":root[data-motion='reduce'] *, :root[data-motion='reduce'] *::before, :root[data-motion='reduce'] *::after",
      ":root[data-spacing='wide'] :where(body *)",
      ":root[data-spacing='wide'] :where(body p:not(:last-child))",
    ]);
  });
});

/* The text size: Windows' own setting and the shortcuts (accesibilidad.md §2.2). */

type Listener = (event: Event) => void;

/** `fakeSystem` plus the window events the text size listens to, which the test fires. */
function fakeWindow(entries: Record<string, string> = {}) {
  const system = fakeSystem(entries);
  const events = new Map<string, Map<Listener, AddEventListenerOptions | boolean | undefined>>();
  const host: AppearanceHost = {
    ...system.host,
    addEventListener: (type: string, listener: Listener, options?: AddEventListenerOptions | boolean) => {
      const listeners = events.get(type) ?? new Map();
      listeners.set(listener, options);
      events.set(type, listeners);
    },
    removeEventListener: (type: string, listener: Listener) => {
      events.get(type)?.delete(listener);
    },
  };
  /** Fires an event at the window; returns whether a listener prevented its default. */
  const fire = (event: Event) => {
    events.get(event.type)?.forEach((_options, listener) => listener(event));
    return event.defaultPrevented;
  };
  const key = (init: KeyboardEventInit) => fire(new KeyboardEvent('keydown', { cancelable: true, ...init }));
  const wheel = (init: WheelEventInit) => fire(new WheelEvent('wheel', { cancelable: true, ...init }));
  const listening = (type: string) => events.get(type)?.size ?? 0;
  const optionsOf = (type: string) => [...(events.get(type)?.values() ?? [])][0];
  return { ...system, host, fire, key, wheel, listening, optionsOf };
}

const storedTextScale = (data: Map<string, string>) =>
  JSON.parse(data.get(ACCESSIBILITY_STORAGE_KEY) ?? '{}').textScale as unknown;

describe('the text size shortcuts', () => {
  beforeEach(resetAccessibility);

  it.each([
    ['+', 'system', 1.1, '17.6px'],
    ['=', 'system', 1.1, '17.6px'],
    ['-', 1.25, 1.1, '17.6px'],
  ] as const)('Ctrl + %s steps the text size from %s and stores it', (key, from, textScale, size) => {
    const { host, data, key: press } = fakeWindow(a11yEntry({ textScale: from }));
    initAppearance(host);
    expect(press({ key, ctrlKey: true })).toBe(true);
    expect(storedTextScale(data)).toBe(textScale);
    expect(root().style.fontSize).toBe(size);
  });

  // Latin American keyboards have a + key of their own and = needs Shift;
  // the numeric keypad gives + and - too.
  it('takes the + of the keypad and of Latin American keyboards', () => {
    const { host, data, key } = fakeWindow();
    initAppearance(host);
    key({ key: '+', code: 'NumpadAdd', ctrlKey: true });
    key({ key: '+', code: 'BracketRight', ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.25);
    key({ key: '-', code: 'NumpadSubtract', ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.1);
  });

  // The text size follows the system by default (David's decision), so
  // Ctrl + 0 goes back to following it, not to a fixed 100 %.
  it("Ctrl + 0 follows the system's size again, from the top row or the keypad", () => {
    const { host, data, key } = fakeWindow({ ...a11yEntry({ textScale: 1.75 }), [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    initAppearance(host);
    expect(root().style.fontSize).toBe('28px');
    expect(key({ key: '0', code: 'Digit0', ctrlKey: true })).toBe(true);
    expect(storedTextScale(data)).toBe('system');
    expect(root().style.fontSize).toBe('20px');
    key({ key: '+', ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.5);
    key({ key: '0', code: 'Numpad0', ctrlKey: true });
    expect(storedTextScale(data)).toBe('system');
    expect(root().style.fontSize).toBe('20px');
  });

  // At 100 % Ctrl + - has nowhere to go, and at 200 % Ctrl + + neither: the
  // size stays, and so does the system's say over it.
  it('keeps following the system after a step that changes nothing', async () => {
    let factor = 1;
    const low = fakeWindow();
    initAppearance(low.host, { readSystemTextScale: async () => factor });
    expect(low.key({ key: '-', ctrlKey: true })).toBe(true);
    expect(low.wheel({ deltaY: 100, ctrlKey: true })).toBe(true);
    expect(low.data.has(ACCESSIBILITY_STORAGE_KEY)).toBe(false);
    // Windows moves to 125 %, and the page still follows.
    factor = 1.25;
    low.fire(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root().style.fontSize).toBe('20px');

    resetAccessibility();
    // Windows at 225 %, which Trino shows at 200 %, and the mode already stored.
    const high = fakeWindow({ ...a11yEntry({ textScale: 'system' }), [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '2.25' });
    initAppearance(high.host);
    high.key({ key: '+', ctrlKey: true });
    high.key({ key: '=', ctrlKey: true });
    expect(storedTextScale(high.data)).toBe('system');
    expect(root().style.fontSize).toBe('32px');
  });

  it("stops following the system's size, from the step after it", () => {
    const { host, data, key } = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.35' });
    initAppearance(host);
    expect(root().style.fontSize).toBe('21.6px');
    key({ key: '+', ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.5);
    expect(root().style.fontSize).toBe('24px');
  });

  it('keeps the other settings', () => {
    const { host, data, key } = fakeWindow(a11yEntry({ vision: 'safe', spacing: 'wide' }));
    initAppearance(host);
    key({ key: '+', ctrlKey: true });
    expect(JSON.parse(data.get(ACCESSIBILITY_STORAGE_KEY)!)).toEqual({
      ...DEFAULT_ACCESSIBILITY,
      vision: 'safe',
      spacing: 'wide',
      textScale: 1.1,
    });
  });

  // Ctrl + Alt is AltGr on Windows, which types characters on many layouts.
  it('leaves keys alone without Ctrl, with Alt or AltGr, and other Ctrl keys', () => {
    const { host, data, key } = fakeWindow();
    initAppearance(host);
    expect(key({ key: '+' })).toBe(false);
    expect(key({ key: '+', ctrlKey: true, altKey: true })).toBe(false);
    expect(key({ key: 'k', ctrlKey: true })).toBe(false);
    expect(data.has(ACCESSIBILITY_STORAGE_KEY)).toBe(false);
  });

  it('applies for the session a size that storage refuses', () => {
    const { host, key } = fakeWindow();
    const refusing: AppearanceHost = {
      ...host,
      localStorage: {
        getItem: key => host.localStorage.getItem(key),
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    };
    initAppearance(refusing);
    key({ key: '+', ctrlKey: true });
    key({ key: '+', ctrlKey: true });
    expect(root().style.fontSize).toBe('20px');
  });

  it('Ctrl + wheel takes one step for every 100 of deltaY, up for a negative one', () => {
    const { host, data, wheel } = fakeWindow();
    // One instant: the pieces belong to one gesture, however slow the run.
    initAppearance(host, { now: () => 0 });
    expect(wheel({ deltaY: -100, ctrlKey: true })).toBe(true);
    expect(storedTextScale(data)).toBe(1.1);
    // A touchpad pinch arrives in small pieces: they add up.
    wheel({ deltaY: -40, ctrlKey: true });
    wheel({ deltaY: -40, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.1);
    wheel({ deltaY: -40, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.25);
    wheel({ deltaY: 250, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1);
  });

  // What is left of one movement would swallow the first notch of the next.
  it('starts the wheel afresh when it turns the other way', () => {
    let now = 0;
    const { host, data, wheel } = fakeWindow();
    initAppearance(host, { now: () => now });
    wheel({ deltaY: -160, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.1);
    now += 50;
    // 60 up was left over: one notch down still takes one step down.
    wheel({ deltaY: 100, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1);
  });

  it('starts the wheel afresh after a pause of 300 ms', () => {
    let now = 0;
    const { host, data, wheel } = fakeWindow(a11yEntry({ textScale: 1.25 }));
    initAppearance(host, { now: () => now });
    wheel({ deltaY: -60, ctrlKey: true });
    now += 301;
    wheel({ deltaY: -60, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.25);
    now += 299;
    wheel({ deltaY: -60, ctrlKey: true });
    expect(storedTextScale(data)).toBe(1.5);
  });

  it('leaves the wheel alone without Ctrl, and listens to it with passive: false to cancel it', () => {
    const { host, data, wheel, optionsOf } = fakeWindow();
    initAppearance(host);
    expect(wheel({ deltaY: -300 })).toBe(false);
    expect(data.has(ACCESSIBILITY_STORAGE_KEY)).toBe(false);
    expect(optionsOf('wheel')).toMatchObject({ passive: false });
  });

  it('stops listening to the keys, the wheel and the focus once disposed', () => {
    const { host, listening } = fakeWindow();
    const dispose = initAppearance(host, { readSystemTextScale: async () => 1 });
    expect([listening('keydown'), listening('wheel'), listening('focus')]).toEqual([1, 1, 1]);
    dispose();
    expect([listening('keydown'), listening('wheel'), listening('focus')]).toEqual([0, 0, 0]);
  });
});

describe("the system's text size", () => {
  beforeEach(resetAccessibility);

  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('paints first with the last size read, kept on the device', () => {
    const { host } = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    initAppearance(host);
    expect(root().style.fontSize).toBe('20px');
    expect(systemSignals(host).textScale).toBe(1.25);
  });

  it('reads the size again, keeps it and corrects the page when it changed', async () => {
    const { host, data } = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    initAppearance(host, { readSystemTextScale: async () => 1.5 });
    await settle();
    expect(data.get(SYSTEM_TEXT_SCALE_STORAGE_KEY)).toBe('1.5');
    expect(root().style.fontSize).toBe('24px');
  });

  // Windows goes up to 225 %; Trino stops at 200 %.
  it('caps 225 % at 200 %', async () => {
    const { host } = fakeWindow();
    initAppearance(host, { readSystemTextScale: async () => 2.25 });
    await settle();
    expect(root().style.fontSize).toBe('32px');
  });

  it('reads it again when the window gets the focus back, since Windows does not tell the page', async () => {
    let factor = 1;
    const { host, fire } = fakeWindow();
    initAppearance(host, { readSystemTextScale: async () => factor });
    await settle();
    expect(root().style.fontSize).toBe('16px');
    factor = 1.25;
    fire(new Event('focus'));
    await settle();
    expect(root().style.fontSize).toBe('20px');
  });

  it('keeps the last size when the read fails, or answers nonsense', async () => {
    const failing = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    initAppearance(failing.host, { readSystemTextScale: () => Promise.reject(new Error('not in Tauri')) });
    await settle();
    expect(root().style.fontSize).toBe('20px');

    resetAccessibility();
    const nonsense = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    initAppearance(nonsense.host, { readSystemTextScale: async () => Number.NaN });
    await settle();
    expect(nonsense.data.get(SYSTEM_TEXT_SCALE_STORAGE_KEY)).toBe('1.25');
    expect(root().style.fontSize).toBe('20px');
  });

  it('starts anyway when the reader throws at once', async () => {
    const { host } = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    const throwing = () => {
      throw new Error('__TAURI_INTERNALS__ is not defined');
    };
    expect(() => initAppearance(host, { readSystemTextScale: throwing })).not.toThrow();
    await settle();
    expect(root().style.fontSize).toBe('20px');
  });

  it('ignores a stored size that is not a number', () => {
    const { host } = fakeWindow({ [SYSTEM_TEXT_SCALE_STORAGE_KEY]: 'big' });
    initAppearance(host);
    expect(root().style.fontSize).toBe('16px');
  });

  it("does not change a size the person chose, but still knows the system's", async () => {
    const { host } = fakeWindow(a11yEntry({ textScale: 1.1 }));
    initAppearance(host, { readSystemTextScale: async () => 1.5 });
    await settle();
    expect(root().style.fontSize).toBe('17.6px');
    expect(systemSignals(host).textScale).toBe(1.5);
  });
});
