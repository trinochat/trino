import { createContext, useContext } from 'react';
import { loadThemePreference, type ThemePreference } from './theme';

// The legacy theme (trino, corporate or simple) that the Settings modal edits.
// App owns the state and provides it; screens read it with `useThemePreference`.
export const ThemeCtx = createContext<{
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}>({
  theme: loadThemePreference(),
  setTheme: () => {},
});

export function useThemePreference(): {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
} {
  return useContext(ThemeCtx);
}
