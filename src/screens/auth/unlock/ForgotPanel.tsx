/**
 * What "¿Olvidaste la contraseña?" opens (Unlock:82-88): nobody can recover
 * it, and the only way out is to wipe this identity, with what that loses.
 */
import { useT } from '../../../lib/i18n';
import { Button } from '../../../ui';

export interface ForgotPanelProps {
  /** For the toggle's aria-controls. */
  id: string;
  /** "Borrar identidad y empezar de cero": asks first, in WipeDialog. */
  onWipe(): void;
}

export function ForgotPanel({ id, onWipe }: ForgotPanelProps) {
  const t = useT();
  return (
    <div id={id} className="flex flex-col gap-3 rounded-ui border border-ui-line bg-ui-bg p-3.5 text-ui-md leading-[1.55]">
      <p className="m-0">{t('unlock2.forgotBody')}</p>
      <p className="m-0 text-ui-muted">{t('unlock2.forgotLoss')}</p>
      <Button variant="danger" onClick={onWipe}>
        {t('unlock2.wipe')}
      </Button>
    </div>
  );
}
