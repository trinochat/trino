/**
 * Asked before locking Trino or closing its window during a call, which
 * hangs up and turns the microphone and camera off. Cancel is the default:
 * it has the focus and Escape gives it. The controller opens it from
 * `confirmEnd` and hangs up on yes; it replaces the old screen's
 * CallConfirmDialog in that use (I5).
 */
import { PhoneOff } from 'lucide-react';
import { useRef } from 'react';
import { useT } from '../../lib/i18n';
import { Button, Dialog, iconSize } from '../../ui';
import type { EndConfirmReason } from './useCallController';

export interface EndCallConfirmDialogProps {
  /** What asks, or null when nothing does. */
  reason: EndConfirmReason | null;
  onAnswer(ok: boolean): void;
}

export function EndCallConfirmDialog({ reason, onAnswer }: EndCallConfirmDialogProps) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={reason !== null}
      onClose={() => onAnswer(false)}
      role="alertdialog"
      size="sm"
      title={t('call2.endConfirm.title')}
      description={t(reason === 'close' ? 'call2.endConfirm.close' : 'call2.endConfirm.lock')}
      initialFocusRef={cancelRef}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} onClick={() => onAnswer(false)}>
          {t('common2.cancel')}
        </Button>
        <Button variant="dangerSolid" leadingIcon={<PhoneOff {...iconSize('md')} />} onClick={() => onAnswer(true)}>
          {t(reason === 'close' ? 'call2.endConfirm.closeConfirm' : 'call2.endConfirm.lockConfirm')}
        </Button>
      </div>
    </Dialog>
  );
}
