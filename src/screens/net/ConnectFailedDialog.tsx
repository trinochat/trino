/**
 * "No se pudo conectar" (PropTorSimple, card 3; Tor design §5.3, §10.3),
 * opened from the inbox's "Ver qué hacer". One big action and small ones:
 *
 * - the network seems to block Tor, or Tor does not finish connecting:
 *   "Probar otra forma de conectarse", the search of card 4 (TOR-8,
 *   bridge-search.ts: the built-in ways in the backend's order, Snowflake
 *   then obfs4, until one connects), then "Volver a intentar", small;
 * - the clock is off, the antivirus took the bridge program, or Arti is too
 *   old: "Volver a intentar" only;
 * - under the note that the chats can be read meanwhile, small and last,
 *   "Conectar sin protección…", which only opens its question (card 5).
 *   Never for the clock, where it would not help.
 *
 * While another way is tried it says so, and that Windows may ask about a
 * program of Trino (lyrebird); the search goes on if the dialog closes, and
 * when no way connected it says why again. It closes once there is nothing
 * to explain:
 * connected, connecting again after "Volver a intentar", or without
 * internet, which the inbox's line says. Nothing here goes without Tor.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import type { NetStatus } from '../../lib/net';
import { Button, cx, Dialog, FOCUS_RING } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import type { NetScreensApi } from './net-api';
import { failureOf, type Failure } from './net-model';
import { useBridgeSearch } from './useBridgeSearch';

export interface ConnectFailedDialogProps {
  status: NetStatus | null;
  api: Pick<NetScreensApi, 'retry' | 'bridges' | 'tryBridge' | 'onNetChanged'>;
  onClose(): void;
  /** "Conectar sin protección…": its question (card 5) takes over. */
  onEscape(): void;
}

/** The small actions under the big one: text that reads as a link. */
export const SMALL_ACTION = cx(
  'min-h-11 rounded-ui px-2 font-ui text-ui-md font-semibold text-ui-accent-text hover:underline',
  FOCUS_RING,
);

export function ConnectFailedDialog({ status, api, onClose, onEscape }: ConnectFailedDialogProps) {
  const t = useT();
  const textId = useId();
  const failure = failureOf(status);
  // What it said last, kept while another way is tried.
  const [shown, setShown] = useState<Failure | null>(failure);
  const [program, setProgram] = useState(false);
  const [search, searcher] = useBridgeSearch(api);
  const trying = search.phase === 'trying';
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    let active = true;
    api.bridges().then(
      info => {
        if (active) setProgram(info.program && info.builtin.length > 0 && info.private !== true);
      },
      () => {
        if (active) setProgram(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (trying) {
      if (status?.state === 'ready' || status?.state === 'direct') latest.current();
      return;
    }
    // Once the search ended: connected, or no way did, and it says why again.
    if (failure) setShown(failure);
    else latest.current();
    // `failure` is derived from `status`.
  }, [status, trying]);

  if (!shown) return null;

  const run = async (command: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setFailed(false);
    try {
      await command();
      after();
    } catch (error) {
      console.error('a network command failed', error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const tryOther =
    shown.tryOther && program
      ? () =>
          void run(
            () => searcher.start(),
            () => setFailed(searcher.get().phase === 'failed'),
          )
      : null;
  const retry = () => void run(() => api.retry(), () => latest.current());

  return (
    <Dialog open size="sm" onClose={onClose} title={t('net.failed.title')} describedBy={textId}>
      <p id={textId} className="m-0 text-ui-base leading-normal text-ui-ink">
        {t(shown.key)}
      </p>
      {trying ? (
        <div className="flex flex-col gap-1.5 border-t border-ui-line pt-3">
          <span role="status" className="text-ui-base font-bold text-ui-ink">
            {t('net.failed.trying')}
          </span>
          <span className="text-ui-md leading-normal text-ui-muted">{t('net.failed.tryingNote')}</span>
        </div>
      ) : tryOther ? (
        <div className="flex flex-col gap-1">
          <Button variant="primary" loading={busy} onClick={tryOther}>
            {t('net.failed.tryOther')}
          </Button>
          <button type="button" disabled={busy} className={cx(SMALL_ACTION, 'self-center')} onClick={retry}>
            {t('net.failed.retry')}
          </button>
        </div>
      ) : (
        <Button variant="primary" loading={busy} onClick={retry}>
          {t('net.failed.retry')}
        </Button>
      )}
      {failed ? <ErrorLine>{t('net.failed.error')}</ErrorLine> : null}
      <p className="m-0 border-t border-ui-line pt-3 text-ui-md leading-normal text-ui-muted">{t('net.failed.meanwhile')}</p>
      {!trying && shown.escape ? (
        <button
          type="button"
          className={cx('min-h-11 self-start rounded-ui px-1 font-ui text-ui-md text-ui-muted underline', FOCUS_RING)}
          onClick={onEscape}
        >
          {t('net.failed.escape')}
        </button>
      ) : null}
    </Dialog>
  );
}
