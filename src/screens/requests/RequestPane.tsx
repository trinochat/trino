/**
 * One request, open where a chat goes (uso responsable UR-4, PropSolicitudes
 * card 4, PropMovilSolicitudes card 3; `Uso responsable/diseno.md` §4.3 and
 * §12.2).
 *
 * - Who they say they are, where it came from and their short fingerprint;
 *   for a contact of a group, "~mara · nombre que puso el admin" (R-10) and
 *   that they are not your contact; for a link, to confirm by another way
 *   that it was them (R-20); in amber, the contact whose name theirs
 *   resembles.
 * - What came: the text as text, a link in it never to be touched (as
 *   Signal does); a file only as "Mandó un archivo (foto, 1,2 MB). Se
 *   descarga si aceptas.", nothing fetched; a call as the line that it did
 *   not ring. Initials, never a photo. No field to write in until accepted.
 * - Eliminar, Bloquear (the shell's confirmation) and Aceptar, the main one.
 *   Reportar (UR-5) after Bloquear.
 *
 * What an answer did is the shell's to show (the chat that opens, or the
 * line that it was deleted); here only why one failed.
 */
import { ArrowLeft, Ban, Check, CircleAlert, Flag, Phone, Trash2, Video } from 'lucide-react';
import { useState } from 'react';
import { isCommandError, type RequestView } from '../../lib/api';
import { clockTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, iconSize, IconButton, MessageBubble } from '../../ui';
import { fileKindOf, shortFingerprint, shownName, sizeText, viaOf } from './requests-model';
import { SaysName } from './SaysName';

export interface RequestPaneProps {
  request: RequestView;
  /** Rejects with `key_clash` or `not_found` as the backend does. */
  onAccept(): Promise<void>;
  onDelete(): Promise<void>;
  /** Opens the confirmation to block them. */
  onBlock(): void;
  /** Opens the report (UR-5). */
  onReport?(): void;
  /** On one pane: back to the list of requests. */
  onBack?(): void;
}

type Failure = 'clash' | 'gone' | 'failed';

const FAILURES: Readonly<Record<Failure, string>> = {
  clash: 'requests.clash',
  gone: 'requests.gone',
  failed: 'requests.failed',
};

function failureOf(reason: unknown): Failure {
  if (isCommandError(reason) && reason.code === 'key_clash') return 'clash';
  if (isCommandError(reason) && reason.code === 'not_found') return 'gone';
  return 'failed';
}

export function RequestPane({ request, onAccept, onDelete, onBlock, onReport, onBack }: RequestPaneProps) {
  const t = useT();
  const { lang } = useLang();
  const [busy, setBusy] = useState<'accept' | 'delete' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const name = shownName(request);
  const fingerprint = t('requests.fingerprint', { fingerprint: shortFingerprint(request.fingerprint) });
  const sub = request.by_admin
    ? `${name} · ${t('requests.byAdmin')} · ${fingerprint}`
    : `${viaOf(request, t)} · ${fingerprint}`;
  const { via } = request;

  const answer = (which: 'accept' | 'delete') => {
    if (busy) return;
    setBusy(which);
    setFailure(null);
    (which === 'accept' ? onAccept() : onDelete()).then(
      () => setBusy(null),
      (reason: unknown) => {
        setBusy(null);
        setFailure(failureOf(reason));
      },
    );
  };

  return (
    <section aria-label={t('requests.paneLabel', { name })} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-ui-line px-4 py-3">
        {onBack ? (
          <IconButton aria-label={t('requests.backToList')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />
        ) : null}
        <Avatar size={40} initials={identityInitials(request.name || '?')} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <SaysName as="h2" className="m-0 break-words text-ui-lg font-normal text-ui-ink" name={name} />
          <p className="m-0 break-words text-ui-sm text-ui-muted">{sub}</p>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {request.looks_like ? (
          <p className="m-0 rounded-ui bg-ui-warn-bg px-3 py-2 text-ui-md font-semibold leading-normal text-ui-warn">
            {t('requests.looksLikeOpen', { contact: request.looks_like })}
          </p>
        ) : null}
        {via.kind === 'group' ? (
          <p className="m-0 text-ui-md leading-normal text-ui-muted">
            {t('requests.groupLine', { name, group: via.group })}
          </p>
        ) : null}
        {via.kind === 'link' ? (
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('requests.linkLine', { label: via.label })}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {request.items.map((item, index) => (
            <li key={`${item.kind}-${item.at}-${index}`}>
              {item.kind === 'text' ? (
                <MessageBubble direction="in" text={item.text} time={clockTime(item.at, lang)} />
              ) : item.kind === 'file' ? (
                <p className="m-0 text-ui-md leading-normal text-ui-muted">
                  {t('requests.file', {
                    kind: t(`requests.kind.${fileKindOf(item.mime)}`),
                    size: sizeText(item.size, lang),
                  })}
                </p>
              ) : (
                <p className="m-0 flex items-center gap-2 text-ui-md leading-normal text-ui-muted">
                  {item.video ? (
                    <Video {...iconSize('md', 'shrink-0')} aria-hidden="true" />
                  ) : (
                    <Phone {...iconSize('md', 'shrink-0')} aria-hidden="true" />
                  )}
                  <span>{t(item.video ? 'requests.callVideo' : 'requests.call', { name, time: clockTime(item.at, lang) })}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
        {request.dropped > 0 ? (
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('requests.dropped', { n: request.dropped })}</p>
        ) : null}
      </div>
      <footer className="flex flex-col gap-2 border-t border-ui-line px-4 py-3">
        {failure ? (
          <p role="alert" className="m-0 flex items-start gap-1.5 text-ui-md font-semibold text-ui-danger">
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{t(FAILURES[failure])}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            leadingIcon={<Trash2 {...iconSize('md')} aria-hidden="true" />}
            loading={busy === 'delete'}
            disabled={busy === 'accept'}
            onClick={() => answer('delete')}
          >
            {t('requests.delete')}
          </Button>
          <Button
            variant="danger"
            leadingIcon={<Ban {...iconSize('md')} aria-hidden="true" />}
            disabled={busy !== null}
            onClick={onBlock}
          >
            {t('block.confirm')}
          </Button>
          {onReport ? (
            <Button leadingIcon={<Flag {...iconSize('md')} aria-hidden="true" />} onClick={onReport} disabled={busy !== null}>
              {t('report.action')}
            </Button>
          ) : null}
          <Button
            className="ms-auto"
            variant="primary"
            leadingIcon={<Check {...iconSize('md')} aria-hidden="true" />}
            loading={busy === 'accept'}
            disabled={busy === 'delete'}
            onClick={() => answer('accept')}
          >
            {t('requests.accept')}
          </Button>
        </div>
      </footer>
    </section>
  );
}
