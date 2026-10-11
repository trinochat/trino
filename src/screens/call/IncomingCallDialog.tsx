/**
 * An incoming call (Call:64-79): who calls and how, "Contacto verificado"
 * only when they are, and the answers. It says nothing about the IP: with
 * TURN the contact never sees it, and when a call cannot be protected the
 * question comes after answering (DirectCallConsentDialog).
 *
 * The call can arrive while you type: the focus goes to the name, not to a
 * button, so a key meant for the chat neither answers nor declines it, and
 * Escape does not decline it either. Tab reaches the answers.
 */
import { Phone, PhoneOff, Video } from 'lucide-react';
import { useId, useRef } from 'react';
import { identityInitials } from '../../lib/initials';
import { useT } from '../../lib/i18n';
import { Avatar, Button, Dialog, TrustBadge, iconSize } from '../../ui';

export interface IncomingCallDialogProps {
  open: boolean;
  name: string;
  avatar: string | null;
  /** A video call: it can be answered with video or with audio only. */
  video: boolean;
  /** Verified on this device. */
  verified: boolean;
  onAnswer(opts: { video: boolean }): void;
  onDecline(): void;
}

export function IncomingCallDialog({ open, name, avatar, video, verified, onAnswer, onDecline }: IncomingCallDialogProps) {
  const t = useT();
  const nameId = useId();
  const kindId = useId();
  const nameRef = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog
      open={open}
      onClose={() => {}}
      role="alertdialog"
      size="sm"
      labelledBy={nameId}
      describedBy={kindId}
      initialFocusRef={nameRef}
      closeOnEscape={false}
      className="items-center px-7 py-8 text-center"
    >
      <Avatar initials={identityInitials(name)} src={avatar ?? undefined} size={96} />
      <div className="flex min-w-0 flex-col items-center gap-1.5">
        <h2
          id={nameId}
          ref={nameRef}
          tabIndex={-1}
          className="m-0 font-ui-display text-[1.5rem] font-bold leading-tight outline-none [overflow-wrap:anywhere]"
        >
          {name}
        </h2>
        <p id={kindId} className="m-0 text-ui-lg text-ui-muted">
          {t(video ? 'call2.incoming.video' : 'call2.incoming.voice')}
        </p>
        {verified && <TrustBadge kind="verified" label={t('call2.incoming.verified')} />}
      </div>
      <div className="flex w-full flex-col gap-2">
        {video ? (
          <>
            <Button variant="primary" size="lg" fullWidth leadingIcon={<Video {...iconSize('md')} />} onClick={() => onAnswer({ video: true })}>
              {t('call2.incoming.answerVideo')}
            </Button>
            <Button size="lg" fullWidth leadingIcon={<Phone {...iconSize('md')} />} onClick={() => onAnswer({ video: false })}>
              {t('call2.incoming.answerAudio')}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" fullWidth leadingIcon={<Phone {...iconSize('md')} />} onClick={() => onAnswer({ video: false })}>
            {t('call2.incoming.answer')}
          </Button>
        )}
        <Button variant="danger" size="lg" fullWidth leadingIcon={<PhoneOff {...iconSize('md')} />} onClick={onDecline}>
          {t('call2.incoming.decline')}
        </Button>
      </div>
    </Dialog>
  );
}
