/**
 * The warning under the header when a contact's security code changed
 * (Main:160-166, K8): it may be a new install of theirs, or someone in the
 * middle. Only the symbols of a call verify a contact (plan-cambios §3.1),
 * so it sends you there, without a gender ("llámale"). Verificar opens the
 * verification; Entendido takes the new code as it is.
 */
import { useT } from '../../lib/i18n';
import { Banner, Button } from '../../ui';

export interface KeyChangeBannerProps {
  /** The contact's name. */
  name: string;
  onVerify?(): void;
  onAcknowledge?(): void;
}

export function KeyChangeBanner({ name, onVerify, onAcknowledge }: KeyChangeBannerProps) {
  const t = useT();
  const actions = (onVerify || onAcknowledge) && (
    <span className="flex flex-wrap gap-2">
      {onVerify && <Button onClick={onVerify}>{t('chat2.verify')}</Button>}
      {onAcknowledge && (
        <Button variant="ghost" onClick={onAcknowledge}>
          {t('chat2.understood')}
        </Button>
      )}
    </span>
  );
  return (
    <Banner tone="warn" action={actions} className="mx-4 mt-3">
      {t('chat2.keyChangedBanner', { name })}
    </Banner>
  );
}
