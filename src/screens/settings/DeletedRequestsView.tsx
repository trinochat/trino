/**
 * "Solicitudes eliminadas" (uso responsable UR-4, PropAjustes › Privacidad;
 * `Uso responsable/diseno.md` §4.3), opened from Settings > Privacidad:
 * whose requests you deleted in the last 30 days, each with its short
 * fingerprint, the day and "Deshacer". What they send in those 30 days is
 * dropped in silence; undoing lets them write again, and what they sent
 * before does not come back. The backend keeps 500 at most.
 *
 * As Bloqueados: until the list is read it says so; when it cannot be read
 * it says that, with "Reintentar"; the empty line shows only when the app
 * knows it. An undone row goes with its button, and the heading takes the
 * focus.
 */
import { ArrowLeft } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { DeletedRequestView } from '../../lib/api';
import { formatFingerprint } from '../../lib/contact-code';
import { dayMonth } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { SettingsSection } from './SettingsSection';

export interface DeletedRequestsViewProps {
  /** Whose requests you deleted, the latest first; null until the list is read. */
  deleted: readonly DeletedRequestView[] | null;
  /** The last reading of the list failed. */
  loadFailed?: boolean;
  /** Reads the list again; resolves to whether it could be read. */
  onRetry?(): Promise<boolean>;
  /** Lets the one `key` names write again. */
  onUndo(key: string): Promise<void>;
  onBack(): void;
  autoFocus?: boolean;
}

/** The first two groups of a fingerprint: "AB12 CD34". */
function shortFingerprint(fingerprint: string): string {
  return formatFingerprint(fingerprint).split(' ').slice(0, 2).join(' ');
}

export function DeletedRequestsView({ deleted, loadFailed = false, onRetry, onUndo, onBack, autoFocus }: DeletedRequestsViewProps) {
  const t = useT();
  const { lang } = useLang();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const title = t('requests.deletedTitle');
  const nameOf = (view: DeletedRequestView) => view.label || t('block.listUnnamed');

  const undo = async (view: DeletedRequestView) => {
    setBusy(view.key);
    setFailed(null);
    setUndone(null);
    try {
      await onUndo(view.key);
      setUndone(nameOf(view));
      heading.current?.focus();
    } catch {
      setFailed(nameOf(view));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (read: () => Promise<boolean>) => {
    setRetrying(true);
    const loaded = await read().catch(() => false);
    setRetrying(false);
    if (loaded) heading.current?.focus();
  };

  const list = (): ReactNode => {
    if (deleted === null) {
      return loadFailed ? null : (
        <p role="status" className="m-0 text-ui-base text-ui-muted">
          {t('settings2.privacy.loading')}
        </p>
      );
    }
    if (deleted.length === 0) {
      return loadFailed ? null : <p className="m-0 text-ui-base text-ui-muted">{t('requests.deletedEmpty')}</p>;
    }
    return (
      <ul
        role="list"
        aria-label={title}
        className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0"
      >
        {deleted.map((view, index) => {
          const name = nameOf(view);
          return (
            <li
              key={view.key}
              className={index > 0 ? 'flex min-h-14 items-center gap-3 border-t border-ui-line px-3.5 py-2' : 'flex min-h-14 items-center gap-3 px-3.5 py-2'}
            >
              <Avatar size={40} initials={identityInitials(view.label || '?')} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words font-ui text-ui-base font-semibold text-ui-ink">{name}</span>
                <span className="text-ui-md text-ui-muted">
                  {t('block.listFingerprint', {
                    fingerprint: shortFingerprint(view.fingerprint),
                    date: dayMonth(view.deleted_at, lang),
                  })}
                </span>
              </span>
              <Button aria-label={t('requests.undoA11y', { name })} loading={busy === view.key} onClick={() => void undo(view)}>
                {t('requests.undo')}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <SettingsSection
      autoFocus={autoFocus}
      headingRef={heading}
      title={title}
      before={<IconButton aria-label={t('settings2.privacy.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('requests.deletedBody')}</p>
      {failed ? <ErrorLine>{t('requests.undoFailed', { name: failed })}</ErrorLine> : null}
      {undone ? (
        <p role="status" className="m-0 text-ui-md leading-normal text-ui-ink">
          {t('requests.undone', { name: undone })}
        </p>
      ) : null}
      {loadFailed ? (
        <>
          <ErrorLine>{t('settings2.privacy.errLoad')}</ErrorLine>
          {onRetry ? (
            <Button className="self-start" loading={retrying} onClick={() => void retry(onRetry)}>
              {t('common2.retry')}
            </Button>
          ) : null}
        </>
      ) : null}
      {list()}
    </SettingsSection>
  );
}
