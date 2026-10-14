/**
 * "¿Conectar sin protección?" (PropTorSimple, card 5; Tor design §10.4,
 * decision 10): the one way to go without Tor, only after this question.
 * It says what it costs and that it lasts until Trino closes; Cancelar is
 * the main button, has the focus and is what Escape gives, so the push is
 * towards staying private (the opposite of the equal buttons elsewhere).
 * Nothing is remembered: the backend keeps it in memory only.
 */
import { useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { Button, Dialog } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import type { NetScreensApi } from './net-api';

export interface WithoutTorDialogProps {
  api: Pick<NetScreensApi, 'connectWithoutTor'>;
  /** Cancelar, Escape: nothing changes. */
  onClose(): void;
  /** Everything goes without Tor now. */
  onDone(): void;
}

export function WithoutTorDialog({ api, onClose, onDone }: WithoutTorDialogProps) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // One answer per question, however many clicks reach the button.
  const asked = useRef(false);

  const confirm = async () => {
    if (asked.current) return;
    asked.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await api.connectWithoutTor();
      onDone();
    } catch (error) {
      console.error('net_connect_without_tor failed', error);
      asked.current = false;
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      size="sm"
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusRef={cancel}
      title={t('net.escape.title')}
      description={t('net.escape.body')}
    >
      {failed ? <ErrorLine>{t('net.escape.error')}</ErrorLine> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button loading={busy} onClick={() => void confirm()}>
          {t('net.escape.confirm')}
        </Button>
        <Button ref={cancel} variant="primary" disabled={busy} onClick={onClose}>
          {t('common2.cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
