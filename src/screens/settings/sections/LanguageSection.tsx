/**
 * Settings > Idioma (Settings:235-248): the three languages, each written
 * in itself and marked with its `lang`, so a screen reader pronounces it
 * right. The choice goes through `useLang().setLang`, which the app saves.
 */
import { LANGS, useT, type Lang } from '../../../lib/i18n';
import { useLang } from '../../../lib/i18n-context';
import { RadioCardGroup } from '../../../ui';
import { SettingsSection } from '../SettingsSection';

export function LanguageSection({ autoFocus }: { autoFocus?: boolean }) {
  const t = useT();
  const { lang, setLang } = useLang();
  return (
    <SettingsSection title={t('settings2.language.title')} autoFocus={autoFocus}>
      <p className="-mt-2 mb-0 text-ui-md text-ui-muted">{t('settings2.language.body')}</p>
      <RadioCardGroup<Lang>
        aria-label={t('settings2.language.title')}
        className="max-w-[22.5rem]"
        value={lang}
        onValueChange={setLang}
        options={LANGS.map(({ code, label }) => ({ value: code, label, lang: code }))}
      />
    </SettingsSection>
  );
}
