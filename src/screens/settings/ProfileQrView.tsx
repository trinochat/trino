/**
 * "Tu código QR" inside Settings (PropAjustes:168-191): back to the profile,
 * the heading, and the share panel of the contacts unit (W4) through
 * `renderShareCode`, with its QR, "Copiar", "Guardar QR" and your key.
 * Settings draws no second QR of its own.
 */
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n';
import { iconSize, IconButton } from '../../ui';
import { SettingsSection } from './SettingsSection';

export interface ProfileQrViewProps {
  onBack(): void;
  renderShareCode(): ReactNode;
  autoFocus?: boolean;
}

export function ProfileQrView({ onBack, renderShareCode, autoFocus }: ProfileQrViewProps) {
  const t = useT();
  return (
    <SettingsSection
      wide
      autoFocus={autoFocus}
      title={t('settings2.qr.title')}
      before={<IconButton aria-label={t('settings2.qr.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {renderShareCode()}
    </SettingsSection>
  );
}
