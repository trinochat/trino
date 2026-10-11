/**
 * The confirmation before wiping the identity from this device: an
 * alertdialog, named by its question and described by what goes, with
 * Cancelar focused, so Enter right away cancels. The confirmation is a solid
 * red button, which always carries an icon (E0b), and says what it does.
 * Mount it when it opens: each opening starts afresh.
 */
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { Banner, Button, Dialog, iconSize } from '../../../ui';
import { attempt } from '../common/attempt';

export interface WipeDialogProps {
  onClose(): void;
  /** `api.wipe`: deletes the identity, the chats and the contacts from this device. */
  wipe(): Promise<void>;
  onWiped(): void;
}

export function WipeDialog({ onClose, wipe, onWiped }: WipeDialogProps) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [wiping, setWiping] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = () => {
    if (wiping) return;
    setWiping(true);
    setFailed(false);
    attempt(wipe).then(onWiped, () => {
      // The backend's message names files on this device: not for the console.
      console.warn('wipe failed');
      setWiping(false);
      setFailed(true);
    });
  };

  return (
    <Dialog
      open
      role="alertdialog"
      size="sm"
      title={t('unlock2.wipeTitle')}
      description={t('unlock2.wipeBody')}
      initialFocusRef={cancelRef}
      closeOnEscape={!wiping}
      onClose={() => {
        if (!wiping) onClose();
      }}
    >
      {failed ? <Banner tone="danger">{t('unlock2.errWipe')}</Banner> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} disabled={wiping} onClick={onClose}>
          {t('unlock2.wipeCancel')}
        </Button>
        <Button variant="dangerSolid" leadingIcon={<Trash2 {...iconSize('md')} />} loading={wiping} onClick={confirm}>
          {wiping ? t('unlock2.wiping') : t('unlock2.wipeConfirm')}
        </Button>
      </div>
    </Dialog>
  );
}
