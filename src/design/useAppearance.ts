/**
 * The appearance as React state: the style, mode and accent the user chose,
 * for the screens that change it (the style step of the first run, W1, and
 * Settings > Appearance, W5).
 *
 * One owner for the `prefers-color-scheme` listener: `initAppearance`, which
 * main.tsx starts before the first render. It reads the stored appearance on
 * every change of the system scheme, so once this provider saves a `system`
 * mode the page keeps following the system. The provider adds no listener.
 */
import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { applyAppearance, darkSchemeQuery, storageOf, type AppearanceHost } from './apply';
import { loadAppearance, saveAppearance, type Appearance } from './appearance';

export interface AppearanceState {
  appearance: Appearance;
  /**
   * Saves the appearance and applies it at once. Returns false when storage
   * refused it: it still applies until the app closes.
   */
  setAppearance(next: Appearance): boolean;
}

const AppearanceContext = createContext<AppearanceState | null>(null);

export interface AppearanceProviderProps {
  children?: ReactNode;
  /** `window`, or a stand-in in tests. */
  host?: AppearanceHost;
}

export function AppearanceProvider({ children, host = window }: AppearanceProviderProps) {
  const [appearance, setState] = useState<Appearance>(() => loadAppearance(storageOf(host)));

  const setAppearance = useCallback(
    (next: Appearance) => {
      const saved = saveAppearance(storageOf(host), next);
      applyAppearance(host.document, next, darkSchemeQuery(host)?.matches ?? false);
      setState(next);
      return saved;
    },
    [host],
  );

  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
  return createElement(AppearanceContext.Provider, { value }, children);
}

export function useAppearance(): AppearanceState {
  const state = useContext(AppearanceContext);
  if (!state) throw new Error('useAppearance needs an AppearanceProvider above it');
  return state;
}
