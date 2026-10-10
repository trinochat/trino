/**
 * The appearance and the accessibility settings as React state, for the
 * screens that change them: the style step of the first run (W1), Settings >
 * Appearance and Settings > Accessibility (W5), and the shell, which takes
 * the root size from here (W2).
 *
 * One owner for the system listeners (colour scheme, contrast, motion, forced
 * colours): `initAppearance`, which main.tsx starts before the first render.
 * It reads the stored settings on every change, so once this provider saves
 * one that follows the system, the page keeps following it. When storage
 * refuses a save, the provider holds the value for the session
 * (`holdAppearance`, `holdAccessibility`, `holdScanLines`) and the listeners
 * follow that instead. The provider adds no listener: it watches the page's
 * refreshes (`watchAppearance`) to learn what the system says.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_ACCESSIBILITY,
  saveAccessibility,
  type Accessibility,
  type EffectiveAccessibility,
  type SystemSignals,
} from './accessibility';
import {
  displayState,
  holdAccessibility,
  holdAppearance,
  holdScanLines,
  prefsOf,
  refreshAppearance,
  storageOf,
  watchAppearance,
  type AppearanceHost,
  type DisplayState,
} from './apply';
import { saveAppearance, type Appearance } from './appearance';

export interface AppearanceState {
  appearance: Appearance;
  /**
   * Saves the appearance and applies it at once. Returns false when storage
   * refused it: it still applies until the app closes, through changes of the
   * system colour scheme too, and the next start shows what was stored before.
   */
  setAppearance(next: Appearance): boolean;
}

export interface AccessibilityState {
  /** What the person chose, `system` included. */
  accessibility: Accessibility;
  /** What is in effect once the system is asked. */
  effective: EffectiveAccessibility;
  /** What the system says, such as Windows' text size for "Como el sistema (125 %)". */
  system: SystemSignals;
  /**
   * Saves a change of one or more settings and applies it at once. Returns
   * false when storage refused it; it still applies until the app closes.
   */
  set(change: Partial<Accessibility>): boolean;
  /** Back to the defaults: everything follows the system again. */
  reset(): boolean;
  /** Terminal dark's scan lines (Settings > Appearance). */
  scanLines: boolean;
  setScanLines(on: boolean): boolean;
}

interface ProviderValue {
  appearance: AppearanceState;
  accessibility: AccessibilityState;
}

const AppearanceContext = createContext<ProviderValue | null>(null);

export interface AppearanceProviderProps {
  children?: ReactNode;
  /** `window`, or a stand-in in tests. */
  host?: AppearanceHost;
}

/** Same settings, same system, same result: nothing to render again. */
function sameDisplay(a: DisplayState, b: DisplayState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function AppearanceProvider({ children, host = window }: AppearanceProviderProps) {
  const [state, setState] = useState<DisplayState>(() => displayState(host));

  const show = useCallback((next: DisplayState) => {
    setState(current => (sameDisplay(current, next) ? current : next));
  }, []);

  // What initAppearance's listeners change reaches the screens through here.
  useEffect(() => watchAppearance(host.document, show), [host, show]);

  const setAppearance = useCallback(
    (next: Appearance) => {
      const saved = saveAppearance(storageOf(host), next);
      holdAppearance(host.document, saved ? null : next);
      show(refreshAppearance(host));
      return saved;
    },
    [host, show],
  );

  const setAccessibility = useCallback(
    (next: Accessibility) => {
      const saved = saveAccessibility(storageOf(host), next);
      holdAccessibility(host.document, saved ? null : next);
      show(refreshAppearance(host));
      return saved;
    },
    [host, show],
  );

  // Read afresh, not from the last render: two changes in one event both count.
  const set = useCallback(
    (change: Partial<Accessibility>) => setAccessibility({ ...displayState(host).accessibility, ...change }),
    [host, setAccessibility],
  );
  const reset = useCallback(() => setAccessibility({ ...DEFAULT_ACCESSIBILITY }), [setAccessibility]);

  const setScanLines = useCallback(
    (on: boolean) => {
      const saved = prefsOf(storageOf(host)).setScanLines(on);
      holdScanLines(host.document, saved ? null : on);
      show(refreshAppearance(host));
      return saved;
    },
    [host, show],
  );

  const value = useMemo<ProviderValue>(
    () => ({
      appearance: { appearance: state.appearance, setAppearance },
      accessibility: {
        accessibility: state.accessibility,
        effective: state.effective,
        system: state.system,
        set,
        reset,
        scanLines: state.scanLines,
        setScanLines,
      },
    }),
    [state, setAppearance, set, reset, setScanLines],
  );
  return createElement(AppearanceContext.Provider, { value }, children);
}

function useProvider(hook: string): ProviderValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error(`${hook} needs an AppearanceProvider above it`);
  return value;
}

export function useAppearance(): AppearanceState {
  return useProvider('useAppearance').appearance;
}

export function useAccessibility(): AccessibilityState {
  return useProvider('useAccessibility').accessibility;
}
