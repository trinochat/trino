/**
 * "Contactos bloqueados" (PropAjustes:225), opened from Settings >
 * Privacidad: each blocked contact with "Desbloquear". Unblocking goes
 * through `onUnblock`, which the section turns into `blockNode(h, false)`.
 */
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import type { NodeInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { SettingsSection } from './SettingsSection';

export interface BlockedContactsViewProps {
  blocked: readonly NodeInfo[];
  onUnblock(handle: string): Promise<void>;
  onBack(): void;
  autoFocus?: boolean;
}

export function BlockedContactsView({ blocked, onUnblock, onBack, autoFocus }: BlockedContactsViewProps) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const unblock = async (handle: string) => {
    setBusy(handle);
    setFailed(null);
    try {
      await onUnblock(handle);
    } catch {
      setFailed(handle);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      autoFocus={autoFocus}
      title={t('settings2.privacy.blocked')}
      before={<IconButton aria-label={t('settings2.privacy.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {failed ? <ErrorLine>{t('settings2.privacy.errUnblock', { name: failed })}</ErrorLine> : null}
      {blocked.length === 0 ? (
        <p className="m-0 text-ui-base text-ui-muted">{t('settings2.privacy.blockedEmpty')}</p>
      ) : (
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
      )}
    </SettingsSection>
  );
}
