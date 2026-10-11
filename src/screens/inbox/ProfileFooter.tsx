/**
 * The foot of the sidebar (Main:113-121): your avatar and name, then your
 * code to share and Settings. The lock moved to Settings and Ctrl+L.
 */
import { QrCode, Settings } from 'lucide-react';
import type { Ref } from 'react';
import { identityInitials } from '../../lib/initials';
import { useT } from '../../lib/i18n';
import { Avatar, IconButton, iconSize } from '../../ui';

export interface ProfileFooterProps {
  me: { handle: string; avatarSrc?: string };
  onShareCode(): void;
  onOpenSettings(): void;
  /** Settings takes the list's place on one pane; closing it brings the focus back here. */
  settingsRef?: Ref<HTMLButtonElement>;
}

export function ProfileFooter({ me, onShareCode, onOpenSettings, settingsRef }: ProfileFooterProps) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 border-t border-ui-line px-1.5 pt-2.5">
      <Avatar size={36} initials={identityInitials(me.handle)} src={me.avatarSrc} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui-md font-semibold">{me.handle}</span>
        <span className="text-ui-sm text-ui-muted">{t('inbox.profile.caption')}</span>
      </span>
      <IconButton aria-label={t('inbox.profile.share')} icon={<QrCode {...iconSize('lg')} />} onClick={onShareCode} />
      <IconButton
        ref={settingsRef}
        aria-label={t('inbox.profile.settings')}
        icon={<Settings {...iconSize('lg')} />}
        onClick={onOpenSettings}
      />
    </div>
  );
}
