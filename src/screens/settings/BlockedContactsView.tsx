/**
 * "Bloqueados" (PropBloquear card 6, PropAjustes:225), opened from Settings >
 * Privacidad: everyone you blocked, contacts or not (uso responsable UR-2,
 * by identity), each with "Desbloquear". A row names them as you do, "~name"
 * for someone known only from a group (the admin wrote that name, R-10),
 * and says their short fingerprint and the day you blocked them; a block of
 * before UR-2 whose contact is gone has neither name nor fingerprint, only
 * its day. Unblocking goes through `onUnblock` with the row's key, and then
 * says what does not come back (R-24).
 *
 * Until the list is read it says so, and when it cannot be read it says
 * that, with "Reintentar": "No has bloqueado a nadie." shows only when the
 * app knows it. An unblocked row goes away with its button, and "Reintentar"
 * goes away once the list loads: the heading takes the focus then, never
 * the page.
 */
import { ArrowLeft } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { BlockedView } from '../../lib/api';
import { formatFingerprint } from '../../lib/contact-code';
import { dayMonth } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { SettingsSection } from './SettingsSection';

export interface BlockedContactsViewProps {
  /** Whom you blocked, the latest first; null until the list is read. */
  blocked: readonly BlockedView[] | null;
  /** The last reading of the list failed: the first one, or the one after an unblock. */
  loadFailed?: boolean;
  /** Reads the list again; resolves to whether it could be read. */
  onRetry?(): Promise<boolean>;
  /** Unblocks the one `key` names; resolves to whom. */
  onUnblock(key: string): Promise<BlockedView>;
  onBack(): void;
  autoFocus?: boolean;
}

/** How a row names them: as you do, "~name" from a group, or "Sin nombre". */
function nameOf(view: BlockedView, unnamed: string): string {
  if (view.contact) return view.contact;
  if (!view.label) return unnamed;
  return view.from === 'group' ? `~${view.label}` : view.label;
}

/** The first two groups of a fingerprint, as the board shows it: "AB12 CD34". */
function shortFingerprint(fingerprint: string): string {
  return formatFingerprint(fingerprint).split(' ').slice(0, 2).join(' ');
}

export function BlockedContactsView({
  blocked,
  loadFailed = false,
  onRetry,
  onUnblock,
  onBack,
  autoFocus,
}: BlockedContactsViewProps) {
  const t = useT();
  const { lang } = useLang();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unblocked, setUnblocked] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const unnamed = t('block.listUnnamed');

  const unblock = async (view: BlockedView) => {
    setBusy(view.key);
    setFailed(null);
    setUnblocked(null);
    try {
      await onUnblock(view.key);
      setUnblocked(nameOf(view, unnamed));
      heading.current?.focus();
    } catch {
      setFailed(nameOf(view, unnamed));
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

  /** The list, or what is known about it. */
  const list = (): ReactNode => {
    if (blocked === null) {
      return loadFailed ? null : (
        <p role="status" className="m-0 text-ui-base text-ui-muted">
          {t('settings2.privacy.loading')}
        </p>
      );
    }
    if (blocked.length === 0) {
      return loadFailed ? null : <p className="m-0 text-ui-base text-ui-muted">{t('settings2.privacy.blockedEmpty')}</p>;
    }
    return (
      <ul
        role="list"
        aria-label={t('settings2.privacy.blocked')}
        className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0"
      >
        {blocked.map((view, index) => {
          const name = nameOf(view, unnamed);
          const date = dayMonth(view.blocked_at, lang);
          return (
            <li
              key={view.key}
              className={index > 0 ? 'flex min-h-14 items-center gap-3 border-t border-ui-line px-3.5 py-2' : 'flex min-h-14 items-center gap-3 px-3.5 py-2'}
            >
              <Avatar size={40} initials={identityInitials(view.label || '?')} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words font-ui text-ui-base font-semibold text-ui-ink">{name}</span>
                <span className="text-ui-md text-ui-muted">
                  {view.fingerprint
                    ? t('block.listFingerprint', { fingerprint: shortFingerprint(view.fingerprint), date })
                    : t('block.listDate', { date })}
                </span>
              </span>
              <Button
                aria-label={t('settings2.privacy.unblockA11y', { name })}
                loading={busy === view.key}
                onClick={() => void unblock(view)}
              >
                {t('settings2.privacy.unblock')}
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
      title={t('settings2.privacy.blocked')}
      before={<IconButton aria-label={t('settings2.privacy.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {failed ? <ErrorLine>{t('settings2.privacy.errUnblock', { name: failed })}</ErrorLine> : null}
      {unblocked ? (
        <p role="status" className="m-0 text-ui-md leading-normal text-ui-ink">
          {t('block.unblocked', { name: unblocked })}
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
