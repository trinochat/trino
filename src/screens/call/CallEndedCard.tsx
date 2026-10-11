/**
 * The end card of a call (Call:166-177): why it ended, with whom and for how
 * long, and that the microphone and camera are off. "Queda registrada en el
 * chat." only once the backend recorded the call (K13). When the key of the
 * connection changed (docs/sas-v2.md) it is an alertdialog that says so.
 * "Cerrar" has the focus, so Enter never calls back by accident.
 */
import { useId, useRef } from 'react';
import { durationLabel } from '../../lib/dates';
import { identityInitials } from '../../lib/initials';
import { useT } from '../../lib/i18n';
import { Avatar, Button, Dialog } from '../../ui';
import type { CallEndReason } from './call-view-model';
import type { CallEndCard } from './useCallController';

export interface CallEndedCardProps {
  /** The call that ended, or null for no card. */
  card: CallEndCard | null;
  onCallAgain(): void;
  onClose(): void;
}

const TITLES: Readonly<Record<CallEndReason, string>> = {
  ended: 'call2.end.title',
  rejected: 'call2.end.rejected',
  'no-answer': 'call2.end.noAnswer',
  connection: 'call2.end.connection',
  microphone: 'call2.end.microphone',
  permission: 'call2.end.permission',
  signal: 'call2.end.signal',
  security: 'call2.end.securityTitle',
};

export function CallEndedCard({ card, onCallAgain, onClose }: CallEndedCardProps) {
  const t = useT();
  const titleId = useId();
  const reasonId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  if (!card) return null;
  const security = card.reason === 'security';
  return (
    <Dialog
      open
      onClose={onClose}
      role={security ? 'alertdialog' : 'dialog'}
      size="sm"
      labelledBy={titleId}
      describedBy={security ? reasonId : undefined}
      initialFocusRef={closeRef}
      className="items-center px-7 py-8 text-center"
    >
      <Avatar initials={identityInitials(card.name)} src={card.avatar ?? undefined} size={64} />
      <h2 id={titleId} className="m-0 font-ui-display text-ui-title font-bold">
        {t(TITLES[card.reason])}
      </h2>
      <p className="m-0 font-ui-mono text-ui-base text-ui-muted [overflow-wrap:anywhere]">
        {card.durationSec === null ? card.name : `${card.name} · ${durationLabel(card.durationSec)}`}
      </p>
      {security && (
        <p id={reasonId} className="m-0 text-ui-md leading-normal text-ui-ink">
          {t('call2.end.security')}
        </p>
      )}
      {card.reason === 'permission' && <p className="m-0 text-ui-md leading-normal text-ui-ink">{t('call2.end.permissionHelp')}</p>}
      <p className="m-0 text-ui-md leading-normal text-ui-muted">
        {card.logged ? `${t('call2.end.logged')} ${t('call2.end.mediaOff')}` : t('call2.end.mediaOff')}
      </p>
      <div className="flex w-full flex-wrap gap-2">
        <Button variant="primary" size="lg" className="flex-[1_1_8rem]" onClick={onCallAgain}>
          {t('call2.end.callAgain')}
        </Button>
        <Button ref={closeRef} size="lg" className="flex-[1_1_8rem]" onClick={onClose}>
          {t('common2.close')}
        </Button>
      </div>
    </Dialog>
  );
}
