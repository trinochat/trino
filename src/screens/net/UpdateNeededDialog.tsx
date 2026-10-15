/**
 * "Trino necesita actualizarse" (PropTorSimple, card 9; Tor design §6.5,
 * R-15): this version of Arti is too old for the Tor network, so Trino
 * cannot connect privately until it is updated, and with Arti down there
 * are no bridges either.
 *
 * - First, Tor Browser: "Ver cómo" gives three steps without technical
 *   words, the address with "Copiar la dirección", and under "Opciones
 *   avanzadas" the release key's fingerprint to check the file's signature.
 * - Then, small, "Descargarla sin protección…": only after its question,
 *   whose safe answer (Cancelar) is the main button, Trino's own updater
 *   looks for the new version without Tor (update_check_without_tor: only
 *   trinochat.org and GitHub, with the same signatures), says how it goes,
 *   and installs only on "Instalar y reiniciar".
 * - When Trino only guesses it (it closed twice right after connecting,
 *   `confirmed: false`), it says "Puede que…" and offers "Volver a intentar".
 *
 * It closes once Tor is anything but too old.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { clipboard } from '../../lib/clipboard';
import { useT } from '../../lib/i18n';
import type { NetStatus, UpdateInfo } from '../../lib/net';
import { Button, cx, Dialog, FOCUS_RING } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import { Advanced } from './Advanced';
import type { NetScreensApi } from './net-api';
import { useUpdateInfo } from './useUpdateInfo';

export interface UpdateNeededDialogProps {
  status: NetStatus | null;
  api: Pick<NetScreensApi, 'retry' | 'checkUpdateWithoutTor' | 'installUpdate' | 'updateStatus' | 'onUpdateChanged'>;
  onClose(): void;
  /** Copies without the clipboard history where it can (src/lib/clipboard.ts). */
  copyText?(text: string): Promise<void>;
}

/** Where Tor Browser downloads Trino. */
const ADDRESS = 'trinochat.org';
/** The release key that signs SHA256SUMS (docs/release.md). */
const RELEASE_KEY = 'BFC6 FA22 2C06 51F1 CC27 C634 A07C 8D60 BFE3 D554';

type View = 'notice' | 'howTo' | 'confirm' | 'progress';

/** The line for the updater's state once it looks without Tor. */
function progressOf(info: UpdateInfo | null): { key: string; ready: boolean; over: boolean } {
  switch (info?.state.state) {
    case 'downloading':
      return { key: 'net.old.downloading', ready: false, over: false };
    case 'ready':
    case 'waitingForCall':
    case 'installing':
    case 'saved':
      return { key: 'net.old.ready', ready: info.state.state === 'ready', over: false };
    case 'failed':
      return { key: 'net.old.failed', ready: false, over: true };
    case 'upToDate':
      return { key: 'net.old.none', ready: false, over: true };
    default:
      return { key: 'net.old.checking', ready: false, over: false };
  }
}

export function UpdateNeededDialog({ status, api, onClose, copyText = clipboard.copyText }: UpdateNeededDialogProps) {
  const t = useT();
  const textId = useId();
  const confirmId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<View>('notice');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const info = useUpdateInfo(api);
  const latest = useRef(onClose);
  latest.current = onClose;

  const obsolete = status?.state === 'obsolete';
  useEffect(() => {
    if (status && !obsolete) latest.current();
  }, [status, obsolete]);
  if (!obsolete) return null;

  const run = async (command: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setFailed(false);
    try {
      await command();
      after?.();
    } catch (error) {
      console.error('an update command failed', error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const copy = () =>
    copyText(`https://${ADDRESS}`).then(
      () => setCopied(true),
      () => setCopied(false),
    );

  if (view === 'confirm') {
    return (
      // Its own key: a dialog of its own, which takes the focus to Cancelar.
      <Dialog key="confirm" open role="alertdialog" size="sm" labelledBy={confirmId} initialFocusRef={cancelRef} onClose={() => setView('notice')}>
        <p id={confirmId} className="m-0 text-ui-base leading-normal text-ui-ink">
          {t('net.old.directBody')}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={() => {
              setView('progress');
              void run(() => api.checkUpdateWithoutTor());
            }}
          >
            {t('net.old.download')}
          </Button>
          <Button ref={cancelRef} variant="primary" onClick={() => setView('notice')}>
            {t('common2.cancel')}
          </Button>
        </div>
      </Dialog>
    );
  }

  const progress = progressOf(info);
  const howTo = (
    <Button variant="primary" onClick={() => setView('howTo')}>
      {t('net.old.howTo')}
    </Button>
  );

  return (
    <Dialog
      key="main"
      open
      size="sm"
      onClose={onClose}
      closeLabel={t('net.old.close')}
      title={t(status.confirmed ? 'net.old.title' : 'net.old.titleMaybe')}
      describedBy={view === 'notice' ? textId : undefined}
    >
      {view === 'notice' ? (
        <>
          <p id={textId} className="m-0 text-ui-base leading-normal text-ui-muted">
            {t('net.old.body')}
          </p>
          {howTo}
          {!status.confirmed ? (
            <Button loading={busy} onClick={() => void run(() => api.retry(), () => latest.current())}>
              {t('net.failed.retry')}
            </Button>
          ) : null}
          <button
            type="button"
            className={cx('min-h-11 self-center rounded-ui px-2 font-ui text-ui-md text-ui-muted underline', FOCUS_RING)}
            onClick={() => setView('confirm')}
          >
            {t('net.old.direct')}
          </button>
        </>
      ) : null}
      {view === 'howTo' ? (
        <>
          <ol className="m-0 flex flex-col gap-1.5 ps-5 text-ui-base leading-normal text-ui-ink">
            <li>{t('net.old.step1')}</li>
            <li>{t('net.old.step2')}</li>
            <li>{t('net.old.step3')}</li>
          </ol>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ui-line pt-3">
            <code className="flex-auto font-ui-mono text-ui-base">{ADDRESS}</code>
            <Button variant="primary" onClick={() => void copy()}>
              {t('net.old.copy')}
            </Button>
          </div>
          <p role="status" className={copied === null ? 'sr-only' : 'm-0 text-ui-md text-ui-muted'}>
            {copied === null ? '' : t(copied ? 'net.old.copied' : 'net.old.notCopied')}
          </p>
          <Advanced>
            <span className="text-ui-md leading-normal text-ui-muted">{t('net.old.signature')}</span>
            <code className="font-ui-mono text-ui-md tracking-[0.03em] [overflow-wrap:anywhere]">{RELEASE_KEY}</code>
          </Advanced>
        </>
      ) : null}
      {view === 'progress' ? (
        <>
          <p role="status" className="m-0 text-ui-base font-semibold leading-normal text-ui-ink">
            {t(progress.key)}
          </p>
          {progress.ready ? (
            <Button variant="primary" loading={busy} onClick={() => void run(() => api.installUpdate())}>
              {t('net.update.install')}
            </Button>
          ) : null}
          {progress.over ? howTo : null}
        </>
      ) : null}
      {failed ? <ErrorLine>{t('net.failed.error')}</ErrorLine> : null}
    </Dialog>
  );
}
