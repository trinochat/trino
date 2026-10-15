/**
 * Opening a link in the browser (PropTorSimple, card 10; Tor design §3 L1,
 * decision 16, R-10). The browser does not go through Tor, so the page sees
 * where you connect from: the backend (links_cmds.rs `open_link`) asks
 * first, until the person ticks "No volver a preguntar", which it keeps in
 * the account, out of the frontend's reach. The WebView cannot open an
 * address itself any more; this only shows the backend's question and
 * passes the answer back.
 *
 * The question shows the address as the browser will open it (a look-alike
 * name in punycode). Abrir is the main button, as drawn; Cancelar and
 * Escape open nothing.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import type { LinkAnswer } from '../../lib/net';
import { useT } from '../../lib/i18n';
import { Button, Checkbox, Dialog } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';

/** The backend: `open_link`, with the yes to its question and its checkbox. */
export interface LinkApi {
  open(url: string, confirmed: boolean, dontAskAgain: boolean): Promise<LinkAnswer>;
}

/** `openLink` for the screens, and the question to render while it is open. */
export interface LinkOpener {
  openLink(url: string): void;
  dialog: ReactNode;
}

export function useLinkOpener(api: LinkApi): LinkOpener {
  const [asking, setAsking] = useState<{ url: string; address: string } | null>(null);
  const openLink = (url: string) => {
    api
      .open(url, false, false)
      .then(answer => {
        if (answer.state === 'ask') setAsking({ url, address: answer.address });
      })
      .catch(error => console.error('open_link failed', error));
  };
  const dialog = asking ? (
    <LinkConfirmDialog key={asking.url} api={api} url={asking.url} address={asking.address} onClose={() => setAsking(null)} />
  ) : null;
  return { openLink, dialog };
}

interface LinkConfirmDialogProps {
  api: LinkApi;
  url: string;
  address: string;
  onClose(): void;
}

function LinkConfirmDialog({ api, url, address, onClose }: LinkConfirmDialogProps) {
  const t = useT();
  const bodyId = useId();
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // One yes per question, however many clicks reach the button.
  const answered = useRef(false);

  const open = async () => {
    if (answered.current) return;
    answered.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await api.open(url, true, dontAsk);
      onClose();
    } catch (error) {
      console.error('open_link failed', error);
      answered.current = false;
      setBusy(false);
      setFailed(true);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      size="sm"
      labelledBy={bodyId}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="flex flex-col gap-3">
        <p id={bodyId} className="m-0 text-ui-md leading-normal text-ui-ink">
          {t('net.link.body')}
        </p>
        <code className="rounded-ui bg-ui-raised px-2.5 py-2 font-ui-mono text-ui-sm [overflow-wrap:anywhere]">{address}</code>
        <Checkbox label={t('net.link.dontAsk')} checked={dontAsk} onChange={event => setDontAsk(event.target.checked)} />
        {failed ? <ErrorLine>{t('net.link.error')}</ErrorLine> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>
            {t('common2.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void open()}>
            {t('net.link.open')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
