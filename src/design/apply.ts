/**
 * Puts the appearance on the page: the `--t-*` variables and the `data-style`
 * and `data-mode` attributes of <html>. It coexists with the legacy theme
 * (`src/lib/theme.ts`), which owns `data-theme` and the `--color-*` variables
 * of the current screens.
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
  root.dataset.style = appearance.style;
  root.dataset.mode = mode;
}

/**
 * Applies the stored appearance now (before the first render, so nothing
 * flashes) and again whenever the system colour scheme changes while the
 * stored mode is `system`. Without storage or `matchMedia` it falls back to
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
    const appearance = loadAppearance(storage);
    if (appearance.mode === 'system') applyAppearance(host.document, appearance, prefersDark());
  });
}

function storageOf(host: AppearanceHost): AppearanceStorage {
  try {
    return host.localStorage ?? NO_STORAGE;
  } catch {
    return NO_STORAGE;
  }
}

function darkSchemeQuery(host: AppearanceHost): MediaQueryList | null {
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
