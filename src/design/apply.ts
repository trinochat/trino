/**
 * Puts the appearance on the page: the `--t-*` variables and the `data-style`
 * and `data-mode` attributes of <html>. It coexists with the legacy theme
 * (`src/lib/theme.ts`), which owns `data-theme` and the `--color-*` variables
 * of the current screens.
 *
 * `--t-color-scheme` holds the resolved mode for the native parts of the new
 * controls (`COLOR_SCHEME` in src/ui/controls/styles.ts). `color-scheme`
 * itself stays off <html>, where it would also restyle the legacy screens.
 */
import {
  cssVariables,
  loadAppearance,
  resolveMode,
  resolveTokens,
  type Appearance,
  type AppearanceStorage,
} from './appearance';

/** What `initAppearance` needs from `window`. */
export interface AppearanceHost {
  readonly document: Document;
  readonly localStorage: AppearanceStorage;
  readonly matchMedia?: (query: string) => MediaQueryList;
}

const DARK_SCHEME = '(prefers-color-scheme: dark)';
const NO_STORAGE: AppearanceStorage = { getItem: () => null, setItem: () => {} };

export function applyAppearance(doc: Document, appearance: Appearance, prefersDark: boolean): void {
  const mode = resolveMode(appearance.mode, prefersDark);
  const root = doc.documentElement;
  const variables = cssVariables(resolveTokens(appearance.style, mode, appearance.accent));
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.style.setProperty('--t-color-scheme', mode);
  root.dataset.style = appearance.style;
  root.dataset.mode = mode;
}

/** The appearance each page holds for this session, over the stored one. */
const held = new WeakMap<Document, Appearance>();

/**
 * Holds an appearance that storage refused for the rest of the session, so
 * the system colour scheme listener of `initAppearance` re-applies it rather
 * than what storage still has. `null` lets the stored appearance lead again.
 */
export function holdAppearance(doc: Document, appearance: Appearance | null): void {
  if (appearance) held.set(doc, appearance);
  else held.delete(doc);
}

/**
 * Applies the stored appearance now (before the first render, so nothing
 * flashes) and again whenever the system colour scheme changes while the
 * mode is `system`: the mode of the appearance held for this session, or
 * else of the stored one. Without storage or `matchMedia` it falls back to
 * the defaults and light. Returns a function that stops listening.
 */
export function initAppearance(host: AppearanceHost): () => void {
  const storage = storageOf(host);
  const query = darkSchemeQuery(host);
  const prefersDark = () => query?.matches ?? false;
  applyAppearance(host.document, loadAppearance(storage), prefersDark());
  if (!query) return () => {};
  return onChange(query, () => {
    // Read it again: the appearance may have been saved since start-up.
    const appearance = held.get(host.document) ?? loadAppearance(storage);
    if (appearance.mode === 'system') applyAppearance(host.document, appearance, prefersDark());
  });
}

/** The host's storage, or one that keeps nothing when it cannot be reached. */
export function storageOf(host: AppearanceHost): AppearanceStorage {
  try {
    return host.localStorage ?? NO_STORAGE;
  } catch {
    return NO_STORAGE;
  }
}

/** The `prefers-color-scheme: dark` query, or null without `matchMedia`. */
export function darkSchemeQuery(host: AppearanceHost): MediaQueryList | null {
  try {
    return host.matchMedia?.(DARK_SCHEME) ?? null;
  } catch {
    return null;
  }
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
