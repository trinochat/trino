/**
 * Ajustes › Privacidad › Conexión (PropTorSimple, cards 6 and 7; Tor
 * design §10.2, §10.4, §10.6), in plain words:
 *
 * - the state under the title: "Conectado de forma privada", connecting,
 *   could not, or, in the warning colour, "Sin protección hasta que cierres
 *   Trino" with "Volver a conectarse de forma privada" as the one big
 *   button;
 * - three things in view: "Qué ven los demás" (card 7, its own view), and
 *   "Buscar actualizaciones cada día" (on by default; it always asks before
 *   installing, and without protection nothing is looked for);
 * - "Opciones avanzadas", closed: "Conectarse solo después de desbloquear",
 *   on and fixed with a connection code someone gave you (private bridge
 *   lines always start at unlock, R-01);
 * - small and last, "Conectar sin protección (solo esta vez)…", which only
 *   opens its question (card 5).
 *
 * "Si en tu red bloquean Tor" (card 4, the other ways to connect) joins the
 * list with TOR-8. Tor itself has no switch: it is always on, and the only
 * way without it is "solo esta vez".
 */
import { ArrowLeft } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useT } from '../../lib/i18n';
import type { BridgesInfo, UpdateInfo } from '../../lib/net';
import { Button, cx, FOCUS_RING, IconButton, iconSize, Switch } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import { SettingsRows } from '../settings/SettingsRows';
import { SettingsSection } from '../settings/SettingsSection';
import { listenAll } from '../shell/listen';
import { Advanced } from './Advanced';
import type { NetScreensApi } from './net-api';
import { settingsStatusOf } from './net-model';
import { useNetStatus } from './useNetStatus';
import { WithoutTorDialog } from './WithoutTorDialog';

export interface ConnectionViewProps {
  api: NetScreensApi;
  /** "Volver a Privacidad". */
  onBack(): void;
  autoFocus?: boolean;
}

export function ConnectionView({ api, onBack, autoFocus }: ConnectionViewProps) {
  const t = useT();
  const status = useNetStatus(api);
  const [view, setView] = useState<'main' | 'seen'>('main');
  const [moved, setMoved] = useState(false);
  const [updates, setUpdates] = useState<UpdateInfo | null>(null);
  const [bridges, setBridges] = useState<BridgesInfo | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const direct = status?.state === 'direct';

  useEffect(() => {
    let active = true;
    api.updateStatus().then(
      info => active && setUpdates(info),
      error => console.error('update_status failed', error),
    );
    api.bridges().then(
      info => active && setBridges(info),
      error => console.error('net_bridges_get failed', error),
    );
    const stop = listenAll([api.onUpdateChanged(info => active && setUpdates(info))]);
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  /** A change shown at once, and back as it was if it cannot be kept. */
  const change = async <T,>(show: () => void, undo: () => void, command: () => Promise<T>, take: (answer: T) => void) => {
    show();
    setFailed(false);
    try {
      take(await command());
    } catch (error) {
      console.error('a setting of the connection was not kept', error);
      undo();
      setFailed(true);
    }
  };

  const setDaily = (on: boolean) => {
    const before = updates;
    void change(
      () => setUpdates(current => current && { ...current, daily: on }),
      () => setUpdates(before),
      () => api.setDailyUpdates(on),
      setUpdates,
    );
  };

  const fixed = bridges?.private === true;
  const onUnlock = fixed || bridges?.start === 'on_unlock';
  const setOnUnlock = (on: boolean) => {
    const before = bridges;
    void change(
      () => setBridges(current => current && { ...current, start: on ? 'on_unlock' : 'open' }),
      () => setBridges(before),
      () => api.setStartOnUnlock(on),
      setBridges,
    );
  };

  const backToTor = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.backToTor();
    } catch (error) {
      console.error('net_back_to_tor failed', error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (view === 'seen') {
    return (
      <WhatOthersSee
        onBack={() => {
          setMoved(true);
          setView('main');
        }}
      />
    );
  }

  return (
    <SettingsSection
      autoFocus={autoFocus || moved}
      title={t('net.settings.title')}
      before={<IconButton aria-label={t('net.settings.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      <p
        role="status"
        className={cx('-mt-3 mb-0 text-ui-md leading-normal', direct ? 'font-bold text-ui-warn' : 'text-ui-muted')}
      >
        {t(settingsStatusOf(status))}
      </p>
      {direct ? (
        <Button variant="primary" loading={busy} onClick={() => void backToTor()} className="self-start">
          {t('net.settings.backToTor')}
        </Button>
      ) : null}
      {failed ? <ErrorLine>{t('net.settings.errSave')}</ErrorLine> : null}
      <SettingsRows
        label={t('net.settings.title')}
        items={[{ id: 'seen', label: t('net.settings.seen'), onSelect: () => setView('seen') }]}
      />
      {updates ? (
        <Switch
          className="border-y border-ui-line py-3.5"
          label={t('net.settings.daily')}
          description={t(direct ? 'net.settings.dailyUnprotected' : 'net.settings.dailyBody')}
          checked={updates.daily}
          onCheckedChange={setDaily}
        />
      ) : null}
      <Advanced>
        {bridges ? (
          <Switch
            className="border-y border-ui-line py-3.5"
            label={t('net.settings.onUnlock')}
            description={t(fixed ? 'net.settings.onUnlockFixed' : 'net.settings.onUnlockBody')}
            checked={onUnlock}
            disabled={fixed}
            onCheckedChange={setOnUnlock}
          />
        ) : null}
      </Advanced>
      {direct ? null : (
        <button
          type="button"
          className={cx('min-h-11 self-start rounded-ui px-1 font-ui text-ui-md text-ui-muted underline', FOCUS_RING)}
          onClick={() => setAsking(true)}
        >
          {t('net.settings.escape')}
        </button>
      )}
      {asking ? <WithoutTorDialog api={api} onClose={() => setAsking(false)} onDone={() => setAsking(false)} /> : null}
    </SettingsSection>
  );
}

/** "Qué ven los demás" (card 7): three short lines, one that promises nothing more, the detail under "Opciones avanzadas". */
function WhatOthersSee({ onBack }: { onBack(): void }) {
  const t = useT();
  const id = useId();
  return (
    <SettingsSection
      autoFocus
      title={<span id={id}>{t('net.seen.title')}</span>}
      before={<IconButton aria-label={t('net.seen.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      <ul
        role="list"
        aria-labelledby={id}
        className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0"
      >
        {['net.seen.servers', 'net.seen.provider', 'net.seen.calls'].map((key, index) => (
          <li key={key} className={cx('px-3.5 py-2.5 text-ui-base leading-normal text-ui-ink', index > 0 && 'border-t border-ui-line')}>
            {t(key)}
          </li>
        ))}
      </ul>
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.seen.note')}</p>
      <Advanced>
        <ul role="list" className="m-0 flex list-disc flex-col gap-1.5 ps-5 text-ui-md leading-normal text-ui-muted">
          {['net.seen.bridges', 'net.seen.microsoft', 'net.seen.folder'].map(key => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </Advanced>
    </SettingsSection>
  );
}
