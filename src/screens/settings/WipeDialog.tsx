/**
 * "¿Borrar todo de este equipo?": an alert dialog that starts on Cancel, as
 * Escape does. Its text is honest (plan §1.5): `wipe` asks no relay to
 * delete anything, so what your contacts already got stays on their
 * devices. The confirm button is a solid red one with its icon and a verb.
 */
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { Button, Dialog, iconSize } from '../../ui';
import { ErrorLine } from './ErrorLine';
import type { SettingsApi } from './types';

export interface WipeDialogProps {
  api: Pick<SettingsApi, 'wipe'>;
  onClose(): void;
  /** Everything is gone from this device: the app starts over. */
  onWiped(): void;
}

export function WipeDialog({ api, onClose, onWiped }: WipeDialogProps) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const wipe = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.wipe();
      onWiped();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusRef={cancel}
      title={t('settings2.wipe.title')}
      description={t('settings2.wipe.body')}
    >
      {failed ? <ErrorLine>{t('settings2.wipe.error')}</ErrorLine> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancel} disabled={busy} onClick={onClose}>
          {t('common2.cancel')}
        </Button>
        <Button variant="dangerSolid" leadingIcon={<Trash2 {...iconSize('md')} />} loading={busy} onClick={() => void wipe()}>
          {t('settings2.wipe.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}
