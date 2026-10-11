/**
 * "Contactos bloqueados" (PropAjustes:225), opened from Settings >
 * Privacidad: each blocked contact with "Desbloquear". Unblocking goes
 * through `onUnblock`, which the section turns into `blockNode(h, false)`.
 *
 * Until the contacts are read it says so, and when they cannot be read it
 * says that, with "Reintentar": "No tienes contactos bloqueados." shows only
 * when the app knows it. An unblocked contact's row goes away with its
 * button, and "Reintentar" goes away once the list loads: the heading takes
 * the focus then, never the page.
 */
import { ArrowLeft } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { NodeInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { SettingsSection } from './SettingsSection';

export interface BlockedContactsViewProps {
  /** The blocked contacts; null until the contacts are read. */
  blocked: readonly NodeInfo[] | null;
  /** The last reading of the contacts failed: the first one, or the one after an unblock. */
  loadFailed?: boolean;
  /** Reads the contacts again; resolves to whether they could be read. */
  onRetry?(): Promise<boolean>;
  onUnblock(handle: string): Promise<void>;
  onBack(): void;
  autoFocus?: boolean;
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
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const unblock = async (handle: string) => {
    setBusy(handle);
    setFailed(null);
    try {
      await onUnblock(handle);
      heading.current?.focus();
    } catch {
      setFailed(handle);
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

  /** The contacts, or what is known about them. */
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
        {blocked.map((contact, index) => (
          <li
            key={contact.handle}
            className={index > 0 ? 'flex min-h-14 items-center gap-3 border-t border-ui-line px-3.5 py-2' : 'flex min-h-14 items-center gap-3 px-3.5 py-2'}
          >
            <Avatar size={40} src={contact.avatar ?? undefined} initials={identityInitials(contact.handle)} />
            <span className="min-w-0 flex-1 break-words font-ui text-ui-base font-semibold text-ui-ink">
              {contact.handle}
            </span>
            <Button
              aria-label={t('settings2.privacy.unblockA11y', { name: contact.handle })}
              loading={busy === contact.handle}
              onClick={() => void unblock(contact.handle)}
            >
              {t('settings2.privacy.unblock')}
            </Button>
          </li>
        ))}
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
