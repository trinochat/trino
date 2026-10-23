/**
 * "Cómo funciona" (CE-8): the help of the emergency key, a view of Settings
 * opened from its page, with the back arrow of the other views. Only text
 * (help.ts): it asks the backend nothing and is the same with a key or
 * without one (CE-D6).
 */
import { ArrowLeft } from 'lucide-react';
import { useId } from 'react';
import { useT } from '../../../lib/i18n';
import { iconSize, IconButton } from '../../../ui';
import { SettingsSection } from '../SettingsSection';
import { HELP } from './help';

export interface EmergencyHelpViewProps {
  /** Back to the page of the emergency key. */
  onBack(): void;
}

export function EmergencyHelpView({ onBack }: EmergencyHelpViewProps) {
  const t = useT();
  const id = useId();
  return (
    <SettingsSection
      autoFocus
      title={t('emergency.help.title')}
      before={<IconButton aria-label={t('emergency.help.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {HELP.map((section, index) => (
        <div key={section.title} className="flex flex-col gap-2">
          <h3 id={`${id}-${index}`} className="m-0 text-ui-lg font-bold text-ui-ink">
            {t(section.title)}
          </h3>
          <ul
            role="list"
            aria-labelledby={`${id}-${index}`}
            className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0 text-ui-md leading-normal text-ui-ink"
          >
            {section.items.map((line, at) => (
              <li key={line} className={at === 0 ? 'px-3 py-2' : 'border-t border-ui-line px-3 py-2'}>
                {t(line)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </SettingsSection>
  );
}
