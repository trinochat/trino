/**
 * Settings > Privacidad (plan-cambios-11oct §4 W5): "Bloqueados" with how
 * many there are, which opens their list (uso responsable UR-2: everyone
 * you blocked by identity, contacts or not); "Solicitudes eliminadas"
 * (UR-4), with how many, when the app gives them; "Reportes enviados"
 * (UR-5), only codes and days for 30 days; and one fixed line on
 * how calls protect your IP (TURN through Cloudflare, docs/llamadas-turn.md).
 *
 * And "Bloquear capturas de pantalla" (SC-1; David, 12 Oct: on by default,
 * and anyone can turn it off): each change goes to the window at once
 * through `setContentProtected`, and is kept in this device's preferences,
 * where main.tsx reads it before unlocking (src/app/capture-protection.ts).
 * Its words say what it does not do: a photo of the screen with another
 * phone. On macOS some recorders ignore it, and the text says so; Linux has
 * nothing for it, so the switch is not there.
 *
 * "En este equipo" (cifrado local, design §11.1), under the blocked
 * contacts: "Tus datos en este equipo", which opens what Trino keeps
 * encrypted with your password, what stays in clear for the unlock screen
 * and what lies outside Trino (LocalDataView.tsx), or, for an account whose
 * migration has not finished (`dataMoved` false), what is not encrypted yet;
 * and, on Windows,
 * "Bloquear Trino al bloquear Windows" (CL-6a; David's decision 4: on by
 * default), kept with the account's preferences, where the backend reads it
 * when Windows locks or the computer sleeps. Under it, on Windows too,
 * "Protección reforzada" (CL-6b, design §10 and §11.1; David's decision 5),
 * off by default: it sets the auto-lock to a minute, locking with Windows
 * on, notifications to "Nada" (only "Nuevo mensaje", groups and calls
 * included), the window out of captures, and copies cleared after 30
 * seconds (src/lib/clipboard.ts); each can still be changed on its own, and
 * turning it off gives back what it changed (src/screens/settings/
 * reinforced.ts). While on, a line suggests device encryption and shutting
 * the computer down. Windows only, as the copies it clears and the lock it
 * turns on are Windows'.
 *
 * "Conexión" (TOR-6, PropTorSimple card 6) leads the list when the app
 * gives the network (`net`), with its state as its second line: it opens
 * the connection's view (src/screens/net/ConnectionView.tsx).
 *
 * Not here, on purpose: the IP warning before a call (TURN made it
 * unnecessary), "Quién puede escribirte" (with the age, UR-10), the @name
 * (§8) and the default timer of
 * disappearing messages (later). The rows come from an array, so the
 * invitations unit adds "Que me encuentren por @nombre" and its links there
 * (§8).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BlockedView, DeletedRequestView, SentReportView } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import type { Prefs } from '../../../lib/prefs';
import { prefsSession } from '../../../lib/prefs-session';
import { Switch } from '../../../ui';
import { BlockedContactsView } from '../BlockedContactsView';
import { DeletedRequestsView } from '../DeletedRequestsView';
import { SentReportsView } from '../SentReportsView';
import { ConnectionView } from '../../net/ConnectionView';
import type { NetScreensApi } from '../../net/net-api';
import { settingsStatusOf } from '../../net/net-model';
import { useNetStatus } from '../../net/useNetStatus';
import { ErrorLine } from '../ErrorLine';
import { LocalDataView } from '../LocalDataView';
import { turnOffReinforced, turnOnReinforced } from '../reinforced';
import { SettingsRows, type SettingsRowItem } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi, SettingsPlatform } from '../types';

export interface PrivacySectionProps {
  api: Pick<
    SettingsApi,
    | 'listBlocked'
    | 'unblockIdentity'
    | 'setContentProtected'
    | 'listDeletedRequests'
    | 'undoDeletedRequest'
    | 'listSentReports'
    | 'cancelReport'
  >;
  /** Where the block of screen captures, locking with Windows and Protección reforzada are kept. */
  prefs: Prefs;
  /** Linux cannot keep a window out of captures, and only Windows locks Trino with it. */
  platform: SettingsPlatform;
  /** Someone was unblocked: the shell reads its contacts again. */
  onContactsChanged?(): void;
  /** Protección reforzada changed the auto-lock: App applies it at once. */
  onAutolockChanged?(minutes: number): void;
  /**
   * Whether this account's data is in the encrypted store. False while a
   * migration that stopped before its commit leaves the session on the files
   * of earlier versions (the session's preferences then live in the WebView).
   */
  dataMoved?: boolean;
  /** Tor's state and commands (TOR-6): "Conexión" leads the list with it. */
  net?: NetScreensApi;
  autoFocus?: boolean;
}

type View = 'main' | 'blocked' | 'deletedRequests' | 'sentReports' | 'data' | 'connection';

/** Why the switch of captures failed: the window refused, or the choice could not be kept. */
type CapturesError = 'window' | 'save';

const CAPTURES_ERROR_KEYS: Record<CapturesError, string> = {
  window: 'settings2.privacy.errCaptures',
  save: 'settings2.privacy.errCapturesSave',
};

export function PrivacySection({
  api,
  prefs,
  platform,
  onContactsChanged,
  onAutolockChanged,
  dataMoved = prefsSession.mode !== 'legacy',
  net,
  autoFocus,
}: PrivacySectionProps) {
  const t = useT();
  const netStatus = useNetStatus(net ?? null);
  const [blocked, setBlocked] = useState<readonly BlockedView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Solicitudes eliminadas (UR-4); null until read, and always without the backend for them. */
  const [deletedRequests, setDeletedRequests] = useState<readonly DeletedRequestView[] | null>(null);
  const [deletedFailed, setDeletedFailed] = useState(false);
  const { listDeletedRequests, undoDeletedRequest } = api;
  const hasDeleted = listDeletedRequests !== undefined && undoDeletedRequest !== undefined;
  /** Reportes enviados (UR-5); read when opened. */
  const [reports, setReports] = useState<readonly SentReportView[] | null>(null);
  const [reportsFailed, setReportsFailed] = useState(false);
  const { listSentReports, cancelReport } = api;
  const hasReports = listSentReports !== undefined && cancelReport !== undefined;
  const [view, setView] = useState<View>('main');
  // After the first view, a change of view moves the focus to the new heading.
  const [moved, setMoved] = useState(false);
  const [blockCaptures, setBlockCaptures] = useState(() => prefs.getBlockCaptures());
  const [capturesError, setCapturesError] = useState<CapturesError | null>(null);
  const [lockWithSystem, setLockWithSystem] = useState(() => prefs.getLockWithSystem());
  const [lockWithSystemFailed, setLockWithSystemFailed] = useState(false);
  const [reinforced, setReinforced] = useState(() => prefs.getReinforced());
  const [reinforcedFailed, setReinforcedFailed] = useState(false);

  /** All its values at once; the switches here show what each became. */
  const toggleReinforced = async (on: boolean) => {
    setReinforced(on);
    setReinforcedFailed(false);
    setCapturesError(null);
    setLockWithSystemFailed(false);
    const deps = { prefs, setContentProtected: api.setContentProtected };
    const { ok } = await (on ? turnOnReinforced(deps) : turnOffReinforced(deps));
    setReinforced(prefs.getReinforced());
    setReinforcedFailed(!ok);
    setBlockCaptures(prefs.getBlockCaptures());
    setLockWithSystem(prefs.getLockWithSystem());
    onAutolockChanged?.(prefs.getAutolockMinutes());
  };

  /** Shown as it changes, and back as it was if it cannot be kept. */
  const toggleLockWithSystem = (on: boolean) => {
    const kept = prefs.setLockWithSystem(on);
    setLockWithSystemFailed(!kept);
    setLockWithSystem(kept ? on : !on);
  };

  /** The window first: only a change it took is kept. */
  const toggleCaptures = async (on: boolean) => {
    setBlockCaptures(on);
    setCapturesError(null);
    try {
      await api.setContentProtected(on);
    } catch {
      setBlockCaptures(!on);
      setCapturesError('window');
      return;
    }
    if (!prefs.setBlockCaptures(on)) setCapturesError('save');
  };

  /** Reads whom you blocked; resolves to whether it could be read. */
  const load = useCallback(async () => {
    try {
      setBlocked(await api.listBlocked());
      setLoadFailed(false);
      return true;
    } catch {
      setLoadFailed(true);
      return false;
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Reads whose requests you deleted; resolves to whether it could be read. */
  const loadDeleted = useCallback(async () => {
    if (!listDeletedRequests) return false;
    try {
      setDeletedRequests(await listDeletedRequests());
      setDeletedFailed(false);
      return true;
    } catch {
      setDeletedFailed(true);
      return false;
    }
  }, [listDeletedRequests]);

  useEffect(() => {
    void loadDeleted();
  }, [loadDeleted]);

  /** Reads the reports sent; resolves to whether it could be read. */
  const loadReports = useCallback(async () => {
    if (!listSentReports) return false;
    try {
      setReports(await listSentReports());
      setReportsFailed(false);
      return true;
    } catch {
      setReportsFailed(true);
      return false;
    }
  }, [listSentReports]);

  const rows = useMemo<SettingsRowItem[]>(
    () => [
      ...(net
        ? [
            {
              id: 'connection',
              label: t('net.settings.title'),
              body: t(settingsStatusOf(netStatus)),
              onSelect: () => {
                setMoved(true);
                setView('connection');
              },
            },
          ]
        : []),
      {
        id: 'blocked',
        label: t('settings2.privacy.blocked'),
        value:
          blocked === null ? undefined : blocked.length === 0 ? t('settings2.privacy.blockedNone') : String(blocked.length),
        onSelect: () => {
          setMoved(true);
          setView('blocked');
        },
      },
      ...(hasDeleted
        ? [
            {
              id: 'deletedRequests',
              label: t('requests.deletedTitle'),
              value:
                deletedRequests === null
                  ? undefined
                  : deletedRequests.length === 0
                    ? t('requests.deletedNone')
                    : String(deletedRequests.length),
              onSelect: () => {
                setMoved(true);
                setView('deletedRequests');
              },
            },
          ]
        : []),
      ...(hasReports
        ? [
            {
              id: 'sentReports',
              label: t('report.sentList'),
              onSelect: () => {
                setMoved(true);
                setReports(null);
                void loadReports();
                setView('sentReports');
              },
            },
          ]
        : []),
    ],
    [t, blocked, net, netStatus, hasDeleted, deletedRequests, hasReports, loadReports],
  );

  const onDevice = useMemo<SettingsRowItem[]>(
    () => [
      {
        id: 'data',
        label: t('settings2.privacy.data'),
        body: t(dataMoved ? 'settings2.privacy.dataBody' : 'settings2.privacy.dataBodyNotYet'),
        onSelect: () => {
          setMoved(true);
          setView('data');
        },
      },
    ],
    [t, dataMoved],
  );

  if (view === 'blocked') {
    return (
      <BlockedContactsView
        autoFocus
        blocked={blocked}
        loadFailed={loadFailed}
        onRetry={load}
        onBack={() => setView('main')}
        onUnblock={async key => {
          const gone = await api.unblockIdentity(key);
          // Unblocked, even if the list cannot be read again just now.
          setBlocked(current => (current ? current.filter(view => view.key !== key) : current));
          onContactsChanged?.();
          await load();
          return gone;
        }}
      />
    );
  }

  if (view === 'deletedRequests' && undoDeletedRequest) {
    return (
      <DeletedRequestsView
        autoFocus
        deleted={deletedRequests}
        loadFailed={deletedFailed}
        onRetry={loadDeleted}
        onBack={() => setView('main')}
        onUndo={async key => {
          await undoDeletedRequest(key);
          setDeletedRequests(current => (current ? current.filter(view => view.key !== key) : current));
          await loadDeleted();
        }}
      />
    );
  }

  if (view === 'sentReports' && cancelReport) {
    return (
      <SentReportsView
        autoFocus
        reports={reports}
        loadFailed={reportsFailed}
        onRetry={loadReports}
        onBack={() => setView('main')}
        onCancel={async id => {
          await cancelReport(id);
          await loadReports();
        }}
      />
    );
  }

  if (view === 'connection' && net) {
    return <ConnectionView autoFocus api={net} onBack={() => setView('main')} />;
  }

  if (view === 'data') {
    return <LocalDataView autoFocus platform={platform} moved={dataMoved} onBack={() => setView('main')} />;
  }

  return (
    <SettingsSection title={t('settings2.privacy.title')} autoFocus={autoFocus || moved}>
      {loadFailed ? <ErrorLine>{t('settings2.privacy.errLoad')}</ErrorLine> : null}
      <SettingsRows label={t('settings2.privacy.title')} items={rows} />
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-ui-lg font-bold text-ui-ink">{t('settings2.privacy.onDevice')}</h3>
        <SettingsRows label={t('settings2.privacy.onDevice')} items={onDevice} />
        {platform === 'windows' ? (
          <>
            <Switch
              className="border-y border-ui-line py-3.5"
              label={t('settings2.privacy.lockWithSystem')}
              description={t('settings2.privacy.lockWithSystemBody')}
              checked={lockWithSystem}
              onCheckedChange={toggleLockWithSystem}
            />
            {lockWithSystemFailed ? <ErrorLine>{t('settings2.privacy.errLockWithSystem')}</ErrorLine> : null}
            <Switch
              className="border-b border-ui-line py-3.5"
              label={t('settings2.privacy.reinforced')}
              description={t(reinforced ? 'settings2.privacy.reinforcedOn' : 'settings2.privacy.reinforcedOff')}
              checked={reinforced}
              onCheckedChange={on => void toggleReinforced(on)}
            />
            {reinforcedFailed ? <ErrorLine>{t('settings2.privacy.errReinforced')}</ErrorLine> : null}
            {reinforced ? (
              <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.privacy.reinforcedTip')}</p>
            ) : null}
          </>
        ) : null}
      </div>
      {platform === 'linux' ? null : (
        <div className="flex flex-col gap-2">
          <Switch
            className="border-y border-ui-line py-3.5"
            label={t('settings2.privacy.captures')}
            description={t(platform === 'macos' ? 'settings2.privacy.capturesBodyMac' : 'settings2.privacy.capturesBody')}
            checked={blockCaptures}
            onCheckedChange={on => void toggleCaptures(on)}
          />
          {capturesError ? <ErrorLine>{t(CAPTURES_ERROR_KEYS[capturesError])}</ErrorLine> : null}
        </div>
      )}
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.privacy.callsLine')}</p>
    </SettingsSection>
  );
}
