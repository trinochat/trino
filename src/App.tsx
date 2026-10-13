import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ComponentType } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { I18nContext, makeT, detectLang, type Lang } from './lib/i18n';
import { LangCtx, useDocumentLang } from './lib/i18n-context';
import { prefs } from './lib/prefs';
import { prefsSession, type PrefsSession } from './lib/prefs-session';
import { teardownCall, isCallBusy } from './lib/call';
import {
  api,
  onCallCloseRequested,
  onCallQuitRequested,
  isCommandError,
  type StatusResponse,
  type UnsealResponse,
} from './lib/api';
import { ToastProvider } from './ui';
import { AppearanceProvider } from './design/useAppearance';
import {
  INITIAL_PHASE,
  OnboardingFlow,
  StartupScreen,
  StoreReview,
  UnlockScreen,
  WindowTitlebar,
  needsReview,
  phaseReducer,
  reviewOf,
  type PhaseEvent,
  type StoreReviewApi,
  type WindowApi,
} from './screens/auth';
import type { LockReason, OnboardingApi, UnlockApi } from './screens/types';
import { capabilities } from './app/capabilities';
import { installBrowserChromeGuard } from './app/browser-chrome';
import type { CallGate } from './app/calls';
import { MainScreen, type MainProps } from './app/MainScreen';
import { useAutoLock } from './app/useAutoLock';
import { withAccountPrefs, type AccountPrefsApi } from './app/account-prefs';

export type { MainProps };

const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

/**
 * What App() needs from the backend: `api` of src/lib/api.ts in the app, a
 * fake in the tests. The first run and the unlock screen take their part.
 */
export interface AppApi extends OnboardingApi, UnlockApi, AccountPrefsApi, StoreReviewApi {
  status(): Promise<StatusResponse>;
  lockVault(): Promise<void>;
  /** Whether a call holds the microphone: the window's close and the tray's "Salir" ask first. */
  setCallActive(active: boolean): Promise<void>;
  onCallCloseRequested(cb: () => void): Promise<UnlistenFn>;
  onCallQuitRequested(cb: () => void): Promise<UnlistenFn>;
}

const BACKEND: AppApi = {
  status: api.status,
  lockVault: api.lockVault,
  setCallActive: api.setCallActive,
  onCallCloseRequested,
  onCallQuitRequested,
  checkPassphrase: api.checkPassphrase,
  totpBegin: api.totpBegin,
  totpVerify: api.totpVerify,
  createIdentity: api.createIdentity,
  // The first run saves the photo only: no `about`, the payload of before K12.
  updateProfile: (handle, avatar) => api.updateProfile(handle, avatar),
  unseal: api.unseal,
  wipe: api.wipe,
  prefsSave: api.prefsSave,
  prefsImport: api.prefsImport,
  prefsGet: api.prefsGet,
  clearBrowsingData: api.clearBrowsingData,
  storeChoose: api.storeChoose,
  legacyFilesPreview: api.legacyFilesPreview,
  legacyFilesImport: api.legacyFilesImport,
  legacyFilesRemove: api.legacyFilesRemove,
};

/**
 * This window through Tauri, asked for on each use, so that loading this
 * module needs no Tauri. Closing hides it to the tray; during a call the
 * backend asks first (`call-close-requested`).
 */
const TAURI_WINDOW: WindowApi = {
  minimize: () => void getCurrentWindow().minimize().catch(() => {}),
  toggleMaximize: () => void getCurrentWindow().toggleMaximize().catch(() => {}),
  close: () => void getCurrentWindow().close().catch(() => {}),
  isMaximized: () => getCurrentWindow().isMaximized(),
};

export interface AppProps {
  /** The backend; the real one unless a test brings its own. */
  api?: AppApi;
  /** This window: its title bar, and closing it after a call. */
  windowApi?: WindowApi;
  /** The chats, once Trino is unlocked. */
  Main?: ComponentType<MainProps>;
  /** The account's preferences while unlocked: the one `prefs.ts` reads, unless a test brings its own. */
  session?: PrefsSession;
}

/**
 * The phases before the chats (W1's `phaseReducer`): reading the status, its
 * error, the first run, the unlock screen, what the store found at unlock
 * (cifrado local CL-2b) and the chats. Every lock seals the vault and then
 * reads the status again, with the reason it locked.
 */
function App({ api: given = BACKEND, windowApi = TAURI_WINDOW, Main = MainScreen, session = prefsSession }: AppProps) {
  // Unlocking and the first run resolve once the account's preferences are
  // in memory and the WebView's copy of before was imported (CL-2a), so the
  // chats never open on the defaults.
  const backend = useMemo(() => withAccountPrefs(given, session), [given, session]);
  const [phase, dispatch] = useReducer(phaseReducer, INITIAL_PHASE);
  const [lang, setLangState] = useState<Lang>(detectLang);
  useDocumentLang(lang);
  const t = useMemo(() => makeT(lang), [lang]);
  const setLang = (l: Lang) => {
    localStorage.setItem('lang', l);
    setLangState(l);
  };

  // Trino is an app, not a web page: no browser menu outside the text fields
  // and none of the browser's shortcuts, on every screen (src/app/browser-chrome.ts).
  useEffect(() => installBrowserChromeGuard(window), []);

  // The last lock: the status is read once the vault is sealed.
  const sealing = useRef<Promise<void>>(Promise.resolve());

  // At start, on "Reintentar" and after every lock, read the status; the
  // reducer turns it into the first run or the unlock screen.
  const loading = phase.kind === 'loading';
  useEffect(() => {
    if (!loading) return;
    let live = true;
    sealing.current
      .then(() => backend.status())
      .then(
        status => {
          if (live) dispatch({ type: 'status', status });
        },
        (error: unknown) => {
          console.warn('status failed:', isCommandError(error) ? error.code : 'not a command error');
          if (live) dispatch({ type: 'statusFailed' });
        },
      );
    return () => {
      live = false;
    };
  }, [loading, backend]);

  // The calls live with the chats (src/app/calls.tsx), which hand App their
  // gate while they are open. Locking, closing the window and quitting go
  // through it: during a call, locking and closing ask first and hang up on
  // yes, and quitting hangs up; the bye goes out (and the call's record, when
  // the chats keep a call log) before the vault and its keys close. Without
  // the chats there is no call.
  const callGate = useRef<CallGate | null>(null);
  const registerCallGate = useCallback((gate: CallGate | null) => {
    callGate.current = gate;
  }, []);
  const endCallFor = (reason: 'lock' | 'close' | 'quit'): Promise<boolean> =>
    callGate.current?.confirmEnd(reason) ?? Promise.resolve(true);

  // Every lock path releases the microphone and camera before sealing. The
  // chats go at once, also when sealing fails. The account's preferences
  // still waiting go to the store first, and their copy is forgotten.
  const lockNow = (reason: LockReason) => {
    teardownCall();
    sealing.current = session
      .close()
      .then(() => backend.lockVault())
      .catch(() => console.warn('lock_vault failed'));
    dispatch({ type: 'locked', reason });
  };
  const requestLock = () => {
    void endCallFor('lock').then(ok => {
      if (ok) lockNow({ kind: 'manual' });
    });
  };

  // Ctrl+L locks from anywhere in the chats, as Settings says ("También con
  // Ctrl + L."), and asks first during a call, like "Bloquear". It is the
  // only Ctrl+L: the shell leaves the key to App. A key a screen already
  // took is left alone, and so is Ctrl+Alt, which is AltGr.
  const latestRequestLock = useRef(requestLock);
  useLayoutEffect(() => {
    latestRequestLock.current = requestLock;
  });
  const chatsShown = phase.kind === 'main';
  // The dialog of what the store found waits with the session open: it locks
  // like the chats, by hand and after the idle minutes.
  const sessionShown = chatsShown || phase.kind === 'review';
  useEffect(() => {
    if (!sessionShown) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'l') return;
      event.preventDefault();
      latestRequestLock.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sessionShown]);

  // The backend asks before hiding the window or quitting while a call holds
  // the microphone (see `set_call_active` and the tray "Salir"): the call's
  // gate answers. Quitting does not ask, since the backend exits after a
  // short grace anyway: the call hangs up at once.
  useEffect(() => {
    // A reload in the middle of a call must not leave a stale flag behind.
    backend.setCallActive(false).catch(() => {});
    const close = backend.onCallCloseRequested(() => {
      void endCallFor('close').then(ok => {
        if (!ok) return;
        backend
          .setCallActive(false)
          .then(() => windowApi.close())
          .catch(() => {});
      });
    });
    const quit = backend.onCallQuitRequested(() => {
      void endCallFor('quit').finally(() => backend.setCallActive(false).catch(() => {}));
    });
    return () => {
      close.then(fn => fn());
      quit.then(fn => fn());
    };
    // endCallFor reads the gate when the backend asks, whatever render made it.
  }, [backend, windowApi]);

  // The auto-lock (src/app/useAutoLock.ts): after the minutes saved in
  // Settings without activity, never during a call, and on time from the
  // tray. The time is read from this device each time the chats open, and a
  // new one from Settings applies at once.
  const [autolockMinutes, setAutolockMinutes] = useState(() => prefs.getAutolockMinutes());
  const openChats = (event: PhaseEvent) => {
    setAutolockMinutes(prefs.getAutolockMinutes());
    dispatch(event);
  };
  // Unlocked: what the store found, or the one note after the migration,
  // comes before the chats. Once read and answered, the preferences a choice
  // changed go to the store as soon as it takes writes again.
  const unlocked = (response: UnsealResponse) =>
    openChats(needsReview(response) ? { type: 'review', review: reviewOf(response) } : { type: 'unlocked' });
  const reviewed = () => {
    void session.flush();
    openChats({ type: 'unlocked' });
  };
  useAutoLock({
    enabled: sessionShown,
    minutes: autolockMinutes,
    isCallBusy,
    onLock: minutes => lockNow({ kind: 'idle', minutes }),
  });

  // "Borrar identidad" on the unlock screen, or "Borrar todo de este equipo"
  // in Settings, deleted the vault, the chats and the contacts, and with the
  // store the account's preferences. Their copy in memory is forgotten
  // unsaved, and what the WebView keeps goes too, as the old screen did.
  const wiped = () => {
    session.discard();
    try {
      localStorage.clear();
    } catch {
      // Storage refused: there is nothing it kept.
    }
    dispatch({ type: 'noVault' });
  };

  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      <I18nContext.Provider value={t}>
        <AppearanceProvider>
          <ToastProvider closeLabel={t('common2.close')}>
            <div className="flex h-full flex-col">
              {!isMobile && <WindowTitlebar api={windowApi} />}
              <div className="min-h-0 flex-1 overflow-hidden">
                {phase.kind === 'loading' || phase.kind === 'startupError' ? (
                  <StartupScreen failed={phase.kind === 'startupError'} onRetry={() => dispatch({ type: 'retry' })} />
                ) : null}
                {phase.kind === 'onboarding' ? (
                  <OnboardingFlow
                    api={backend}
                    profileSync={capabilities.profileSync}
                    onCreated={(_created, intent) => openChats({ type: 'created', intent })}
                    onVaultExists={() => dispatch({ type: 'vaultExists' })}
                  />
                ) : null}
                {phase.kind === 'unlock' ? (
                  <UnlockScreen
                    totpEnabled={phase.totpEnabled}
                    reason={phase.reason}
                    api={backend}
                    onUnlocked={unlocked}
                    onNoVault={() => dispatch({ type: 'noVault' })}
                    onWiped={wiped}
                  />
                ) : null}
                {phase.kind === 'review' ? <StoreReview review={phase.review} api={backend} onDone={reviewed} /> : null}
                {phase.kind === 'main' ? (
                  // The chats' own <main> is the pane on screen (src/app/MainScreen.tsx).
                  <div className="h-full">
                    <Main
                      intent={phase.intent}
                      onLock={requestLock}
                      onAutolockChanged={setAutolockMinutes}
                      onWiped={wiped}
                      onCallGate={registerCallGate}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </ToastProvider>
        </AppearanceProvider>
      </I18nContext.Provider>
    </LangCtx.Provider>
  );
}

export default App;
