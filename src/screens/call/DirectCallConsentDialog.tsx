/**
 * The question when a call cannot be protected (TURN failed): call or answer
 * directly, showing your IP to the contact? Asked on every call, never
 * remembered, and the safe answer is the default: it has the focus and
 * Escape gives it (docs/llamadas-turn.md). It reads and writes no
 * preference: the answer goes to call.ts through `onAnswer`, which the
 * controller turns into `answerDirectConsent`.
 */
import { useRef } from 'react';
import type { DirectConsentRequest } from '../../lib/call';
import { useT } from '../../lib/i18n';
import { Button, Dialog } from '../../ui';

export interface DirectCallConsentDialogProps {
  /** The open question (call.ts `onDirectConsent`), or null: the dialog closes when it goes away. */
  consent: DirectConsentRequest | null;
  /** The contact, named in the question when answering. */
  peerName: string;
  /** True only from the confirm button; Escape and the safe button give false. Once per question. */
  onAnswer(allow: boolean): void;
}

export function DirectCallConsentDialog({ consent, peerName, onAnswer }: DirectCallConsentDialogProps) {
  const t = useT();
  const safeRef = useRef<HTMLButtonElement>(null);
  // The question already answered: a second click on it, or a late one, does nothing.
  const answered = useRef<DirectConsentRequest | null>(null);
  const answer = (allow: boolean) => {
    if (!consent || answered.current === consent) return;
    answered.current = consent;
    onAnswer(allow);
  };
  const outgoing = consent?.outgoing ?? true;
  return (
    <Dialog
      open={consent !== null}
      onClose={() => answer(false)}
      role="alertdialog"
      size="sm"
      title={t('call2.consent.title')}
      description={outgoing ? t('call2.consent.bodyOutgoing') : t('call2.consent.bodyIncoming', { name: peerName })}
      initialFocusRef={safeRef}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={safeRef} onClick={() => answer(false)}>
          {outgoing ? t('common2.cancel') : t('call2.consent.cancelIncoming')}
        </Button>
        <Button variant="danger" onClick={() => answer(true)}>
          {outgoing ? t('call2.consent.confirmOutgoing') : t('call2.consent.confirmIncoming')}
        </Button>
      </div>
    </Dialog>
  );
}
