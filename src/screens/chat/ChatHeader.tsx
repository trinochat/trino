/**
 * The header of a chat (Main:125-158): the avatar and the name, which wraps
 * rather than being cut (accesibilidad.md §4.7, rule 3); under it the trust
 * of a contact or the members of a group, and the chip "Temporales: 1 día";
 * then the calls and the details.
 *
 * "Código verificado en este equipo" holds only on this device, which keeps
 * the mark (plan §1.2). An unverified contact offers Verificar. The calls
 * show only for a contact the chat can call, never for one you blocked:
 * their signals would not reach you. A group has a details button too
 * (plan §1.8, deviation 2).
 */
import { ArrowLeft, Ban, Info, Phone, Timer, Video } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { Avatar, Button, IconButton, TrustBadge, iconSize } from '../../ui';
import type { ChatHeaderInfo } from '../types';
import { exactDuration } from './durations';

export interface ChatHeaderProps {
  header: ChatHeaderInfo;
  /** The id of the name's heading, which names the pane. */
  headingId?: string;
  /** Calls the contact; without it, no call buttons. */
  onCall?(video: boolean): void;
  onOpenDetails(): void;
  onVerify?(): void;
  /** Back to the list when there is room for one pane only. */
  onBack?(): void;
}

/** The trust of a contact, or the members of a group, under the name. */
function Status({ header, onVerify }: Pick<ChatHeaderProps, 'header' | 'onVerify'>) {
  const t = useT();
  if (header.kind === 'group') {
    if (header.ended) return <span className="text-ui-muted">{t('chat2.ended')}</span>;
    return (
      <span className="text-ui-muted">
        {header.memberCount === 1 ? t('chat2.member') : t('chat2.members', { n: header.memberCount })}
      </span>
    );
  }
  if (header.blocked) {
    return (
      <span className="inline-flex items-center gap-1 font-semibold text-ui-muted">
        <Ban {...iconSize('md', 'shrink-0')} aria-hidden="true" />
        {t('chat2.blocked')}
      </span>
    );
  }
  switch (header.trust) {
    case 'verified':
      return <TrustBadge kind="verified" label={t('chat2.verified')} />;
    case 'keyChanged':
      return <TrustBadge kind="keyChanged" label={t('chat2.keyChanged')} />;
    case 'unverified':
      return (
        <TrustBadge
          kind="unverified"
          label={t('chat2.unverified')}
          action={onVerify && <Button onClick={onVerify}>{t('chat2.verify')}</Button>}
        />
      );
  }
}

export function ChatHeader({ header, headingId, onCall, onOpenDetails, onVerify, onBack }: ChatHeaderProps) {
  const t = useT();
  const { lang } = useLang();
  const group = header.kind === 'group';
  const calls = header.kind === 'contact' && !header.blocked ? onCall : undefined;
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-ui-line px-4 py-3">
      {onBack && <IconButton aria-label={t('common2.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
      <Avatar
        initials={identityInitials(header.name)}
        src={header.kind === 'contact' ? header.avatarSrc : undefined}
        kind={group ? 'group' : 'person'}
        size={44}
      />
      <div className="flex min-w-0 flex-[1_1_12.5rem] flex-col gap-0.5">
        <h1 id={headingId} className="font-ui-display text-[1.125rem] font-bold leading-tight [overflow-wrap:anywhere]">
          {header.name}
        </h1>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-md">
          <Status header={header} onVerify={onVerify} />
          {header.ttlSeconds > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-ui-line px-2 py-0.5 text-ui-muted">
              <Timer {...iconSize('sm', 'shrink-0')} aria-hidden="true" />
              {t('chat2.ttl', { time: exactDuration(header.ttlSeconds, lang) })}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {calls && (
          <>
            <IconButton aria-label={t('chat2.voiceCall')} icon={<Phone {...iconSize('lg')} />} onClick={() => calls(false)} />
            <IconButton aria-label={t('chat2.videoCall')} icon={<Video {...iconSize('lg')} />} onClick={() => calls(true)} />
          </>
        )}
        <IconButton
          aria-label={t(group ? 'chat2.groupDetails' : 'chat2.details')}
          icon={<Info {...iconSize('lg')} />}
          onClick={onOpenDetails}
        />
      </div>
    </header>
  );
}
