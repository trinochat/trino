/**
 * Solicitudes in the sidebar (uso responsable UR-4, PropSolicitudes card 2,
 * PropMovilSolicitudes card 2; `Uso responsable/diseno.md` §4.3): it takes
 * the place of the chats, as in Telegram, and a request opens where a chat
 * goes. Atrás goes back to the chats.
 *
 * On top, what it is: "No son tus contactos. Nada de aquí suena ni se
 * descarga hasta que aceptes." (for an account of 16 or 17, that only the
 * redemptions of its links come, UR-10); then, when some did not fit, how many. Each
 * row says who they say they are ("dice llamarse ana", "~mara" when the
 * admin of a group wrote the name, R-10), where it came from and when, their
 * latest text, and in amber when the name resembles a contact's. Never a
 * photo: initials only.
 */
import { ArrowLeft, CircleAlert } from 'lucide-react';
import { rowTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, cx, FOCUS_RING, iconSize, IconButton } from '../../ui';
import type { RequestView } from '../../lib/api';
import { previewOf, shownName, viaOf } from './requests-model';
import { SaysName } from './SaysName';

export interface RequestsListProps {
  /** The latest first. */
  requests: readonly RequestView[];
  /** How many did not fit in their source's quota. */
  overflow: number;
  /** The account is of 16 or 17 (UR-10): only its links' redemptions come. */
  onlyLinks?: boolean;
  /** The last reading failed. */
  failed: boolean;
  /** The request open beside the list. */
  selectedKey: string | null;
  /** Epoch seconds, for the times of the rows. */
  now: number;
  onOpen(key: string): void;
  /** Back to the chats. */
  onBack(): void;
  onRetry(): void;
}

export function RequestsList({
  requests,
  overflow,
  onlyLinks = false,
  failed,
  selectedKey,
  now,
  onOpen,
  onBack,
  onRetry,
}: RequestsListProps) {
  const t = useT();
  const { lang } = useLang();
  const title = t('requests.title');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <IconButton aria-label={t('requests.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />
        <h2 className="m-0 font-ui-display text-ui-title font-bold text-ui-ink">{title}</h2>
      </div>
      <p className="m-0 px-1 text-ui-md leading-normal text-ui-muted">{t(onlyLinks ? 'requests.noticeOnlyLinks' : 'requests.notice')}</p>
      {overflow > 0 ? (
        <p className="m-0 px-1 text-ui-md font-semibold leading-normal text-ui-warn">
          {t('requests.overflow', { n: overflow })}
        </p>
      ) : null}
      {failed ? (
        <div className="flex flex-col items-start gap-2 px-1">
          <p role="alert" className="m-0 flex items-start gap-1.5 text-ui-md font-semibold text-ui-danger">
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{t('requests.loadFailed')}</span>
          </p>
          <Button onClick={onRetry}>{t('common2.retry')}</Button>
        </div>
      ) : null}
      {requests.length === 0 ? (
        failed ? null : <p className="m-0 px-1 text-ui-md text-ui-muted">{t('requests.empty')}</p>
      ) : (
        <ul aria-label={title} className="-mx-1 m-0 flex min-h-[8rem] grow basis-0 list-none flex-col gap-0.5 overflow-y-auto p-0 px-1">
          {requests.map(request => {
            const name = shownName(request);
            const selected = request.key === selectedKey;
            return (
              <li key={request.key}>
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onOpen(request.key)}
                  className={cx(
                    'flex w-full items-start gap-3 rounded-ui p-2.5 text-left text-ui-ink hover:bg-ui-raised',
                    selected && 'bg-ui-raised',
                    FOCUS_RING,
                  )}
                >
                  <Avatar size={40} initials={identityInitials(request.name || '?')} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <SaysName className="break-words text-ui-base" name={name} />
                    <span className="text-ui-sm text-ui-muted">
                      {`${viaOf(request, t)} · ${rowTime(request.last_at, now, lang)}`}
                    </span>
                    <span className="truncate text-ui-md text-ui-muted">{previewOf(request, t)}</span>
                    {request.looks_like ? (
                      <span className="text-ui-sm font-semibold text-ui-warn">
                        {t('requests.looksLike', { contact: request.looks_like })}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
