/**
 * "Tus datos en este equipo" (cifrado local, design §11.2), opened from
 * Settings > Privacidad > En este equipo: what Trino keeps encrypted with
 * your password, what stays in clear because the unlock screen needs it, and
 * what lies outside Trino. Each part is a short named list, no panels.
 *
 * Only what is true now: copying without the clipboard history comes with
 * CL-6b, and its line with it. The notifications line names Windows only on
 * Windows.
 */
import { ArrowLeft } from 'lucide-react';
import { useId } from 'react';
import { useT } from '../../lib/i18n';
import { iconSize, IconButton } from '../../ui';
import { SettingsSection } from './SettingsSection';
import type { SettingsPlatform } from './types';

export interface LocalDataViewProps {
  platform: SettingsPlatform;
  onBack(): void;
  autoFocus?: boolean;
}

const PARTS = [
  {
    title: 'settings2.privacy.dataEncrypted',
    lines: [
      'settings2.privacy.dataIdentity',
      'settings2.privacy.dataContacts',
      'settings2.privacy.dataProfile',
      'settings2.privacy.dataNotes',
    ],
  },
  { title: 'settings2.privacy.dataPlain', lines: ['settings2.privacy.dataAccount', 'settings2.privacy.dataLook'] },
  { title: 'settings2.privacy.dataOutside', lines: ['settings2.privacy.dataNotifications', 'settings2.privacy.dataDownloads'] },
] as const;

export function LocalDataView({ platform, onBack, autoFocus }: LocalDataViewProps) {
  const t = useT();
  const id = useId();
  const line = (key: string) =>
    key === 'settings2.privacy.dataNotifications' && platform !== 'windows' ? t('settings2.privacy.dataNotificationsOther') : t(key);
  return (
    <SettingsSection
      autoFocus={autoFocus}
      title={t('settings2.privacy.data')}
      before={<IconButton aria-label={t('settings2.privacy.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {PARTS.map((part, index) => (
        <div key={part.title} className="flex flex-col gap-2">
          <h3 id={`${id}-${index}`} className="m-0 text-ui-lg font-bold text-ui-ink">
            {t(part.title)}
          </h3>
          <ul
            role="list"
            aria-labelledby={`${id}-${index}`}
            className="m-0 flex list-disc flex-col gap-1.5 ps-5 text-ui-base leading-normal text-ui-ink"
          >
            {part.lines.map(key => (
              <li key={key}>{line(key)}</li>
            ))}
          </ul>
        </div>
      ))}
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.privacy.dataCopies')}</p>
    </SettingsSection>
  );
}
