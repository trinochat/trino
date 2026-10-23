/**
 * Settings › Cuenta y seguridad › Clave de emergencia (CE-5, design §8;
 * PropClaveEmergencia cards 2 to 6).
 *
 * **The page is the same for everyone** (CE-D6): it never asks the backend
 * whether a key is set, and shows the explanation, the three buttons
 * ("Configurar o cambiar", "Probar", "Quitar") and the row of the network,
 * whose choice opens only behind the password. Each opens its own view or
 * dialog:
 *
 * - configuring or changing it: EmergencySetup.tsx, four steps;
 * - testing it without erasing: EmergencyTestDialog.tsx (RC-16, RC-17);
 * - removing it: EmergencyRemoveDialog.tsx, the same answer either way;
 * - the network: EmergencyNetworkView.tsx, behind the password.
 */
import { ArrowLeft, Lock } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../../lib/i18n';
import { Button, iconSize, IconButton } from '../../../ui';
import { SettingsRows } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi, SettingsPlatform } from '../types';
import { EmergencyNetworkView } from './EmergencyNetworkView';
import { EmergencyRemoveDialog } from './EmergencyRemoveDialog';
import { EmergencySetup } from './EmergencySetup';
import { EmergencyTestDialog } from './EmergencyTestDialog';

export interface EmergencyKeyViewProps {
  api: Pick<
    SettingsApi,
    | 'setEmergencyKey'
    | 'testEmergencyKey'
    | 'removeEmergencyKey'
    | 'emergencyNetwork'
    | 'saveEmergencyNetwork'
    | 'refreshEmergencyNetwork'
    | 'onEmergencyAlert'
    | 'listNodes'
  >;
  /** Two-step verification is on: each password asked here takes a code too. */
  totpEnabled: boolean;
  /** Protección reforzada is on Windows only. */
  platform: SettingsPlatform;
  /** Back to Cuenta y seguridad. */
  onBack(): void;
  /** Opens Settings › Privacidad, where Protección reforzada is. */
  onOpenReinforced?(): void;
  /** Whether you verified a contact (`prefs.isVerified`): the network section says so (CE-6). */
  isVerified(handle: string, fingerprint: string): boolean;
  autoFocus?: boolean;
}

type View = 'page' | 'setup' | 'network';
type OpenDialog = 'test' | 'remove' | null;

export function EmergencyKeyView({ api, totpEnabled, platform, onBack, onOpenReinforced, isVerified, autoFocus }: EmergencyKeyViewProps) {
  const t = useT();
  const [view, setView] = useState<View>('page');
  const [dialog, setDialog] = useState<OpenDialog>(null);
  // After the first view, coming back to the page moves the focus to its heading.
  const [moved, setMoved] = useState(false);

  const back = () => {
    setMoved(true);
    setView('page');
  };

  let content;
  if (view === 'setup') {
    content = (
      <EmergencySetup
        api={api}
        totpEnabled={totpEnabled}
        platform={platform}
        onClose={back}
        onTest={() => setDialog('test')}
        onOpenNetwork={() => setView('network')}
        {...(onOpenReinforced && { onOpenReinforced })}
      />
    );
  } else if (view === 'network') {
    content = <EmergencyNetworkView api={api} totpEnabled={totpEnabled} isVerified={isVerified} onBack={back} />;
  } else {
    content = (
      <SettingsSection
        autoFocus={autoFocus || moved}
        title={t('emergency.page.title')}
        before={<IconButton aria-label={t('emergency.page.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
      >
        <div className="flex flex-col gap-2">
          <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('emergency.page.what')}</p>
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('emergency.page.totp')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" className="flex-auto" onClick={() => setView('setup')}>
            {t('emergency.page.setup')}
          </Button>
          <Button className="flex-auto" onClick={() => setDialog('test')}>
            {t('emergency.page.test')}
          </Button>
          <Button className="flex-auto" onClick={() => setDialog('remove')}>
            {t('emergency.page.remove')}
          </Button>
        </div>
        <SettingsRows
          label={t('emergency.page.more')}
          items={[
            {
              id: 'network',
              icon: Lock,
              label: t('emergency.page.network'),
              body: t('emergency.page.networkBody'),
              onSelect: () => setView('network'),
            },
          ]}
        />
      </SettingsSection>
    );
  }

  return (
    <>
      {content}
      {dialog === 'test' ? <EmergencyTestDialog api={api} onClose={() => setDialog(null)} /> : null}
      {dialog === 'remove' ? <EmergencyRemoveDialog api={api} totpEnabled={totpEnabled} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
