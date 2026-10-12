/**
 * Puts the appearance and the accessibility settings on the page: the `--t-*`
 * variables, the `data-style` and `data-mode` attributes of <html>, the
 * accessibility marks (`data-vision`, `data-contrast`, `data-motion`,
 * `data-spacing`) that the Tailwind variants and `base.css` read, and the root
 * font size that every rem follows.
 *
 * `--t-color-scheme` holds the resolved mode for the native parts of the
 * controls, which each control applies (`COLOR_SCHEME` in
 * src/ui/controls/styles.ts). <html> itself gets no `color-scheme`.
 */
import { createPrefs, type Prefs } from '../lib/prefs';
import { STANDARD_A11Y, type A11yLayers } from './a11y-tokens';
import {
  SYSTEM_TEXT_SCALE_STORAGE_KEY,
  loadAccessibility,
  resolveAccessibility,
  saveAccessibility,
  stepTextScale,
  type Accessibility,
  type EffectiveAccessibility,
  type SystemSignals,
} from './accessibility';
import {
  cssVariables,
  loadAppearance,
  resolveMode,
  resolveTokens,
  saveAppearance,
  type Appearance,
  type AppearanceStorage,
} from './appearance';

/** What `initAppearance` needs from `window`. */
export interface AppearanceHost {
  readonly document: Document;
  readonly localStorage: AppearanceStorage;
  readonly matchMedia?: (query: string) => MediaQueryList;
  /** For the text size shortcuts, and to read the system's text size again on focus. */
  addEventListener?(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

export interface InitAppearanceOptions {
  /**
   * Reads the system's text size as a factor, such as 1.25 for Windows at
   * 125 % (`api.systemTextScale`). Without it, the last size read stays.
   */
  readSystemTextScale?: () => Promise<number>;
  /** The clock of the Ctrl + wheel gestures, in ms: `performance.now` by default. */
  now?: () => number;
}

const DARK_SCHEME = '(prefers-color-scheme: dark)';
const MORE_CONTRAST = '(prefers-contrast: more)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const FORCED_COLORS = '(forced-colors: active)';
/** Every system setting the page follows; `initAppearance` owns their listeners. */
const SYSTEM_QUERIES = [DARK_SCHEME, MORE_CONTRAST, REDUCED_MOTION, FORCED_COLORS] as const;

/** The root font size at 100 %, so 1rem is 16 px as the code says. */
export const ROOT_PX = 16;

/** Ctrl + wheel takes one step of text size for this much `deltaY` (a mouse notch). */
const WHEEL_STEP = 100;
/** A pause this long between two Ctrl + wheel events ends a gesture, in ms. */
const WHEEL_PAUSE_MS = 300;

const NO_STORAGE: AppearanceStorage = { getItem: () => null, setItem: () => {} };

/**
 * Sets the tokens of the appearance as CSS variables, with the accessibility
 * layers in effect; without them, the standard ones.
 */
export function applyAppearance(
  doc: Document,
  appearance: Appearance,
  prefersDark: boolean,
  layers: A11yLayers = STANDARD_A11Y,
): void {
  const mode = resolveMode(appearance.mode, prefersDark);
  const root = doc.documentElement;
  const variables = cssVariables(resolveTokens(appearance.style, mode, appearance.accent, layers));
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.style.setProperty('--t-color-scheme', mode);
  root.dataset.style = appearance.style;
  root.dataset.mode = mode;
}

/**
 * Marks <html> with the accessibility settings in effect and sets the root
 * font size: 16 px times the text scale, so everything in rem grows with it.
 */
export function applyAccessibility(doc: Document, effective: EffectiveAccessibility): void {
  const root = doc.documentElement;
  root.dataset.vision = effective.vision;
  root.dataset.contrast = effective.contrast;
  root.dataset.motion = effective.motion;
  root.dataset.spacing = effective.spacing;
  root.style.fontSize = `${ROOT_PX * effective.textScale}px`;
}

/**
 * Whether scripts should skip motion (smooth scrolling, the pulses of a call):
 * what the settings and the system decided, as `data-motion` says.
 */
export function prefersReducedMotion(doc: Document): boolean {
  return doc.documentElement.dataset.motion === 'reduce';
}

/** What each page holds for this session over what storage has. */
interface Held {
  appearance?: Appearance;
  accessibility?: Accessibility;
  scanLines?: boolean;
}

const held = new WeakMap<Document, Held>();

function hold<K extends keyof Held>(doc: Document, key: K, value: Held[K] | null): void {
  const current = { ...held.get(doc) };
  if (value === null) delete current[key];
  else current[key] = value;
  held.set(doc, current);
}

/**
 * Holds an appearance that storage refused for the rest of the session, so
 * the system listeners of `initAppearance` re-apply it rather than what
 * storage still has. `null` lets the stored appearance lead again.
 */
export function holdAppearance(doc: Document, appearance: Appearance | null): void {
  hold(doc, 'appearance', appearance);
}

/** The same for the accessibility settings. */
export function holdAccessibility(doc: Document, accessibility: Accessibility | null): void {
  hold(doc, 'accessibility', accessibility);
}

/** The same for the scan lines of Terminal dark. */
export function holdScanLines(doc: Document, on: boolean | null): void {
  hold(doc, 'scanLines', on);
}

/** Everything that decides how the page looks, and where it comes from. */
export interface DisplayState {
  appearance: Appearance;
  accessibility: Accessibility;
  scanLines: boolean;
  /** What the system says. */
  system: SystemSignals;
  /** The accessibility settings in effect, after the system. */
  effective: EffectiveAccessibility;
  prefersDark: boolean;
}

/** The settings held for this session, or else the stored ones, with what the system says now. */
export function displayState(host: AppearanceHost): DisplayState {
  const storage = storageOf(host);
  const kept = held.get(host.document) ?? {};
  const accessibility = kept.accessibility ?? loadAccessibility(storage);
  const system = systemSignals(host);
  return {
    appearance: kept.appearance ?? loadAppearance(storage),
    accessibility,
    scanLines: kept.scanLines ?? prefsOf(storage).getScanLines(),
    system,
    effective: resolveAccessibility(accessibility, system),
    prefersDark: matches(host, DARK_SCHEME),
  };
}

type Watcher = (state: DisplayState) => void;

const watchers = new WeakMap<Document, Set<Watcher>>();

/**
 * Applies the display state again: the settings read afresh (they may have
 * been saved since start-up) and what the system says now. Then it tells the
 * watchers, such as the provider of `useAccessibility`.
 */
export function refreshAppearance(host: AppearanceHost): DisplayState {
  const state = displayState(host);
  const { appearance, effective, prefersDark, scanLines } = state;
  applyAccessibility(host.document, effective);
  applyAppearance(host.document, appearance, prefersDark, {
    vision: effective.vision,
    contrast: effective.contrast,
    scanLines,
  });
  watchers.get(host.document)?.forEach(watcher => watcher(state));
  return state;
}

/**
 * Calls `watcher` after each refresh of the page, until the returned function
 * runs. A watcher hears of system changes without a listener of its own:
 * `initAppearance` stays their one owner.
 */
export function watchAppearance(doc: Document, watcher: Watcher): () => void {
  const set = watchers.get(doc) ?? new Set<Watcher>();
  watchers.set(doc, set);
  set.add(watcher);
  return () => {
    set.delete(watcher);
  };
}

/**
 * Saves the appearance and applies it at once. When storage refuses it, it
 * is held for the session instead; returns whether it was saved.
 */
export function changeAppearance(host: AppearanceHost, next: Appearance): boolean {
  const saved = saveAppearance(storageOf(host), next);
  holdAppearance(host.document, saved ? null : next);
  refreshAppearance(host);
  return saved;
}

/** The same for the accessibility settings. */
export function changeAccessibility(host: AppearanceHost, next: Accessibility): boolean {
  const saved = saveAccessibility(storageOf(host), next);
  holdAccessibility(host.document, saved ? null : next);
  refreshAppearance(host);
  return saved;
}

/** The same for the scan lines of Terminal dark. */
export function changeScanLines(host: AppearanceHost, on: boolean): boolean {
  const saved = prefsOf(storageOf(host)).setScanLines(on);
  holdScanLines(host.document, saved ? null : on);
  refreshAppearance(host);
  return saved;
}

/** What a text size shortcut asks for: a step up or down, or the system's size. */
type TextSizeShortcut = Parameters<typeof stepTextScale>[1] | 'system';

/**
 * Applies a text size shortcut. A step goes from the size in effect and is
 * stored as the person's own choice, which no longer follows the system; a
 * step that changes nothing, such as Ctrl + `-` at 100 %, stores nothing,
 * so whatever followed the system still does. `system` follows it again.
 */
function changeTextSize(host: AppearanceHost, shortcut: TextSizeShortcut): void {
  const { accessibility, effective } = displayState(host);
  if (shortcut === 'system') {
    if (accessibility.textScale !== 'system') changeAccessibility(host, { ...accessibility, textScale: 'system' });
    return;
  }
  const textScale = stepTextScale(effective.textScale, shortcut);
  if (textScale !== effective.textScale) changeAccessibility(host, { ...accessibility, textScale });
}

/**
 * The text size shortcut of a key, by `event.key`: Ctrl + `+` or `=` up (`+`
 * has its own key on Latin American keyboards, where `=` needs Shift; the
 * keypad gives `+` too), Ctrl + `-` down, Ctrl + 0 back to the system's size,
 * which the text size follows by default. Ctrl + Alt is AltGr on Windows,
 * which types characters, so it is left alone.
 */
function shortcutOf(event: KeyboardEvent): TextSizeShortcut | null {
  if (!event.ctrlKey || event.altKey || event.defaultPrevented) return null;
  if (event.key === '+' || event.key === '=') return 'up';
  if (event.key === '-') return 'down';
  if (event.key === '0') return 'system';
  return null;
}

/** The system's text size read last in this session, per window. */
const systemTextScales = new WeakMap<AppearanceHost, number>();

/**
 * Applies the stored appearance and accessibility settings now (before the
 * first render, so nothing flashes or jumps) and again whenever the system
 * changes its colour scheme, contrast, motion or forced colours: the settings
 * held for this session, or else the stored ones. Without storage or
 * `matchMedia` it falls back to the defaults, light and 16 px.
 *
 * It also owns the text size shortcuts (Ctrl + `+`, Ctrl + `-`, Ctrl + 0 and
 * Ctrl + wheel), and reads the system's text size at start and whenever the
 * window gets the focus back, since Windows does not tell the page. Returns a
 * function that stops listening.
 */
export function initAppearance(host: AppearanceHost, options: InitAppearanceOptions = {}): () => void {
  refreshAppearance(host);
  const refresh = () => {
    refreshAppearance(host);
  };
  const stops = SYSTEM_QUERIES.flatMap(media => {
    const query = mediaQuery(host, media);
    return query ? [onChange(query, refresh)] : [];
  });

  const onKeyDown = (event: Event) => {
    const shortcut = shortcutOf(event as KeyboardEvent);
    if (!shortcut) return;
    event.preventDefault();
    changeTextSize(host, shortcut);
  };
  // A touchpad pinch arrives as Ctrl + wheel in small pieces: they add up, so
  // one gesture does not jump from 100 to 200 %. What is left of a gesture
  // goes once the wheel turns the other way or pauses, or it would swallow
  // the first notch of the next one.
  const now = options.now ?? (() => performance.now());
  let wheel = 0;
  let lastWheel = Number.NEGATIVE_INFINITY;
  const onWheel = (event: Event) => {
    const { ctrlKey, deltaY } = event as WheelEvent;
    if (!ctrlKey) return;
    event.preventDefault();
    const at = now();
    if (deltaY * wheel < 0 || at - lastWheel >= WHEEL_PAUSE_MS) wheel = 0;
    lastWheel = at;
    wheel += deltaY;
    while (Math.abs(wheel) >= WHEEL_STEP) {
      changeTextSize(host, wheel < 0 ? 'up' : 'down');
      wheel -= Math.sign(wheel) * WHEEL_STEP;
    }
  };
  let stopped = false;
  const readSystemTextScale = () => {
    const read = options.readSystemTextScale;
    if (!read) return;
    // Outside Tauri (vite dev) the read fails, at once or later: the last size stays.
    Promise.resolve()
      .then(read)
      .then(
        factor => {
          if (stopped || !Number.isFinite(factor) || factor <= 0) return;
          if (factor === systemSignals(host).textScale) return;
          systemTextScales.set(host, factor);
          write(storageOf(host), SYSTEM_TEXT_SCALE_STORAGE_KEY, String(factor));
          refreshAppearance(host);
        },
        () => {},
      );
  };
  host.addEventListener?.('keydown', onKeyDown);
  // Not passive, so it can cancel the event: no scrolling or zooming of the webview.
  host.addEventListener?.('wheel', onWheel, { passive: false });
  host.addEventListener?.('focus', readSystemTextScale);
  readSystemTextScale();

  return () => {
    stopped = true;
    stops.forEach(stop => stop());
    host.removeEventListener?.('keydown', onKeyDown);
    host.removeEventListener?.('wheel', onWheel);
    host.removeEventListener?.('focus', readSystemTextScale);
  };
}

/**
 * What the system says now, read without listening. The text size is the
 * one read last: in this session, or else at an earlier start.
 */
export function systemSignals(host: AppearanceHost): SystemSignals {
  return {
    textScale: systemTextScales.get(host) ?? storedSystemTextScale(storageOf(host)),
    moreContrast: matches(host, MORE_CONTRAST),
    reducedMotion: matches(host, REDUCED_MOTION),
    forcedColors: matches(host, FORCED_COLORS),
  };
}

function storedSystemTextScale(storage: AppearanceStorage): number {
  let stored: string | null = null;
  try {
    stored = storage.getItem(SYSTEM_TEXT_SCALE_STORAGE_KEY);
  } catch {
    // Unreadable storage: 100 %.
  }
  const factor = Number(stored);
  return stored !== null && Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function write(storage: AppearanceStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // The value still applies for this session.
  }
}

/** The host's storage, or one that keeps nothing when it cannot be reached. */
export function storageOf(host: AppearanceHost): AppearanceStorage {
  try {
    return host.localStorage ?? NO_STORAGE;
  } catch {
    return NO_STORAGE;
  }
}

/** The preferences of this device over the host's storage. */
export function prefsOf(storage: AppearanceStorage): Prefs {
  return createPrefs({
    getItem: key => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: key => (storage as Partial<Storage>).removeItem?.(key),
  });
}

/** The system query, or null without `matchMedia`. */
function mediaQuery(host: AppearanceHost, media: string): MediaQueryList | null {
  try {
    return host.matchMedia?.(media) ?? null;
  } catch {
    return null;
  }
}

function matches(host: AppearanceHost, media: string): boolean {
  return mediaQuery(host, media)?.matches ?? false;
}

function onChange(query: MediaQueryList, listener: () => void): () => void {
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }
  // WebKit before Safari 14 (macOS 10.15) only has the deprecated API.
  query.addListener(listener);
  return () => query.removeListener(listener);
}
