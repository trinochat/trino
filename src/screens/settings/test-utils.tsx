/**
 * Helpers for the tests of Settings and the contact details. Only test files
 * import this module: the app never does.
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import type { AppearanceHost } from '../../design/apply';
import type { NodeInfo, ProfileResponse } from '../../lib/api';
import { I18nContext, makeT, type Lang } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { createPrefs, type Prefs, type PrefsStorage } from '../../lib/prefs';
import type { SettingsApi } from './types';

/** Storage in memory, as `localStorage` would keep it. */
export function memoryStorage(initial: Record<string, string> = {}): PrefsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: key => {
      data.delete(key);
    },
  };
}

/** Preferences over a fresh memory storage, and that storage. */
export function memoryPrefs(initial: Record<string, string> = {}): { prefs: Prefs; storage: ReturnType<typeof memoryStorage> } {
  const storage = memoryStorage(initial);
  return { prefs: createPrefs(storage), storage };
}

export const PROFILE: ProfileResponse = {
  handle: 'rechita',
  avatar: null,
  fingerprint: '70a5.83c6.766d.aad7',
  nostr_pub: 'ab12'.repeat(16),
  about: 'Respondo en las tardes.',
  sync: 1,
};

/** A contact as `list_nodes` gives it. */
export function node(handle: string, extra: Partial<NodeInfo> = {}): NodeInfo {
  return { handle, fingerprint: '1111.2222.3333.4444', has_session: true, added_at: 0, ...extra };
}

/** A backend that answers like a fresh identity; each test overrides what it needs. */
export function fakeApi(overrides: Partial<SettingsApi> = {}): SettingsApi {
  return {
    getProfile: vi.fn(async () => PROFILE),
    updateProfile: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      has_vault: true,
      is_unsealed: true,
      handle: PROFILE.handle,
      nostr_pub: PROFILE.nostr_pub,
      home_dir: '',
      totp_enabled: false,
    })),
    totpBegin: vi.fn(async () => ({ otpauth_uri: 'otpauth://totp/Trino:rechita?secret=JBSWY3DPEHPK3PXP', secret_base32: 'JBSWY3DPEHPK3PXP' })),
    totpVerify: vi.fn(async () => true),
    totpEnable: vi.fn(async () => {}),
    totpDisable: vi.fn(async () => {}),
    changePassphrase: vi.fn(async () => {}),
    wipe: vi.fn(async () => {}),
    getAutostart: vi.fn(async () => false),
    setAutostart: vi.fn(async () => {}),
    connectionStatus: vi.fn(async () => ({ up: 0, total: 0, relays: [] })),
    relayInspectStart: vi.fn(async () => []),
    relayInspectStop: vi.fn(async () => {}),
    onRelayEvent: vi.fn(async () => () => {}),
    testNotification: vi.fn(async () => 'shown' as const),
    getVersion: vi.fn(async () => '0.1.0'),
    listNodes: vi.fn(async () => []),
    blockNode: vi.fn(async () => {}),
    setContentProtected: vi.fn(async () => {}),
    ...overrides,
  };
}

/** The texts of a language around a screen, and the language switch of LangCtx. */
export function withLang(ui: ReactNode, lang: Lang = 'es', setLang: (l: Lang) => void = () => {}): ReactElement {
  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      <I18nContext.Provider value={makeT(lang)}>{ui}</I18nContext.Provider>
    </LangCtx.Provider>
  );
}

export function renderEs(ui: ReactNode): RenderResult {
  return render(withLang(ui));
}

/** A rejected command as the backend gives it. */
export function commandError(code: string, extra: Record<string, unknown> = {}) {
  return { code, message: code, ...extra };
}

/**
 * A window stand-in for the AppearanceProvider: its storage, and the system's
 * colour scheme, contrast and motion, all quiet unless the test says.
 */
export function fakeHost(
  stored: Record<string, string> = {},
  system: { dark?: boolean; moreContrast?: boolean; reducedMotion?: boolean } = {},
): { host: AppearanceHost; storage: ReturnType<typeof memoryStorage> } {
  const storage = memoryStorage(stored);
  const answers: Record<string, boolean> = {
    '(prefers-color-scheme: dark)': system.dark ?? false,
    '(prefers-contrast: more)': system.moreContrast ?? false,
    '(prefers-reduced-motion: reduce)': system.reducedMotion ?? false,
  };
  const host: AppearanceHost = {
    document,
    localStorage: storage,
    matchMedia: media =>
      ({
        matches: answers[media] ?? false,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  };
  return { host, storage };
}
