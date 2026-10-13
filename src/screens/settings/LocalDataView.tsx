/**
 * "Tus datos en este equipo" (cifrado local, design §11.2), opened from
 * Settings > Privacidad > En este equipo: what Trino keeps encrypted with
 * your password, what stays in clear because the unlock screen needs it, and
 * what lies outside Trino. Each part is a short named list, no panels.
 *
 * Only what is true now: the notifications line names Windows only on
 * Windows, and only there does Trino copy without the clipboard history
 * (CL-6b, src/lib/clipboard.ts), so its line is Windows' alone. The capture
 * switch stays in the WebView with the appearance (`DEVICE_KEYS` in
 * src/lib/prefs-session.ts), so it is named among what stays in clear,
 * except on Linux, which has no such switch.
 *
 * An account whose migration stopped before its commit (`moved` false: the
 * unlock answer's `prefs_import` "unavailable", Storage::Legacy) keeps its
 * contacts, groups, profile, stickers and notes as earlier versions did, and
 * the next unlock tries again: those lines move to "Todavía sin cifrar".
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
  /** Whether this account's data is in the store; false while its migration has not finished. */
  moved?: boolean;
}

interface Part {
  title: string;
  lines: readonly string[];
  /** A muted line under the list. */
  note?: string;
}

/** What the store keeps beyond the identity and the chats, which earlier versions encrypted too. */
const MOVED_LINES = ['settings2.privacy.dataContacts', 'settings2.privacy.dataProfile', 'settings2.privacy.dataNotes'];

function partsFor(moved: boolean): Part[] {
  return [
    {
      title: 'settings2.privacy.dataEncrypted',
      lines: moved ? ['settings2.privacy.dataIdentity', ...MOVED_LINES] : ['settings2.privacy.dataIdentity'],
    },
    ...(moved ? [] : [{ title: 'settings2.privacy.dataNotYet', lines: MOVED_LINES, note: 'settings2.privacy.dataNotYetBody' }]),
    {
      title: 'settings2.privacy.dataPlain',
      lines: ['settings2.privacy.dataAccount', 'settings2.privacy.dataLook', 'settings2.privacy.dataCaptures'],
    },
    {
      title: 'settings2.privacy.dataOutside',
      lines: ['settings2.privacy.dataNotifications', 'settings2.privacy.dataDownloads', 'settings2.privacy.dataClipboard'],
    },
  ];
}

/** Lines that are true on some systems only. */
function shown(key: string, platform: SettingsPlatform): boolean {
  if (key === 'settings2.privacy.dataClipboard') return platform === 'windows';
  if (key === 'settings2.privacy.dataCaptures') return platform !== 'linux';
  return true;
}

export function LocalDataView({ platform, onBack, autoFocus, moved = true }: LocalDataViewProps) {
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
      {partsFor(moved).map((part, index) => (
        <div key={part.title} className="flex flex-col gap-2">
          <h3 id={`${id}-${index}`} className="m-0 text-ui-lg font-bold text-ui-ink">
            {t(part.title)}
          </h3>
          <ul
            role="list"
            aria-labelledby={`${id}-${index}`}
            className="m-0 flex list-disc flex-col gap-1.5 ps-5 text-ui-base leading-normal text-ui-ink"
          >
            {part.lines
              .filter(key => shown(key, platform))
              .map(key => (
                <li key={key}>{line(key)}</li>
              ))}
          </ul>
          {part.note ? <p className="m-0 text-ui-md leading-normal text-ui-muted">{t(part.note)}</p> : null}
        </div>
      ))}
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.privacy.dataCopies')}</p>
    </SettingsSection>
  );
}
