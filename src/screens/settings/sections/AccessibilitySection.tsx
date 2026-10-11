/**
 * Settings > Accesibilidad (accesibilidad.md §2 and §6, plan-cambios-11oct
 * §4 W5): the text size, colours for colour blindness, more contrast,
 * reduced motion and wide spacing, all through `useAccessibility()`. They
 * belong to this device and apply before unlocking too.
 *
 * The text size follows the system by default: "Como el sistema (N %)"
 * shows the size in effect that way, which Trino reads from Windows; macOS
 * and Linux give it none, so there it is 100 %. Moving the slider fixes a
 * step and stops following the system. Contrast and motion follow the
 * system until touched, then say so and offer "Usar lo del sistema".
 * Everything is in rem, so the preview, like the page, grows with the size.
 */
import { Check, CircleAlert, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DEFAULT_ACCESSIBILITY, nearestTextScale, TEXT_SCALES, type Accessibility } from '../../../design/accessibility';
import { useAccessibility } from '../../../design/useAppearance';
import { useT } from '../../../lib/i18n';
import { Button, cx, iconSize, Switch } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { KeyboardShortcutsDialog } from '../KeyboardShortcutsDialog';
import { SettingsSection } from '../SettingsSection';
import type { SettingsPlatform } from '../types';

export interface AccessibilitySectionProps {
  platform: SettingsPlatform;
  autoFocus?: boolean;
}

const MIN_SCALE = TEXT_SCALES[0];
const MAX_SCALE = TEXT_SCALES[TEXT_SCALES.length - 1];
const percent = (factor: number) => Math.round(factor * 100);

/** The warnings as colour blindness turns them: an icon and a word each, never a dot. */
const LEGEND: ReadonlyArray<{ Icon: LucideIcon; tone: string; label: string }> = [
  { Icon: ShieldCheck, tone: 'text-ui-ok', label: 'settings2.a11y.legendVerified' },
  { Icon: ShieldAlert, tone: 'text-ui-warn', label: 'settings2.a11y.legendKeyChanged' },
  { Icon: CircleAlert, tone: 'text-ui-danger', label: 'settings2.a11y.legendFailed' },
];

const ROW = 'border-b border-ui-line py-3.5';

function differsFromDefaults(settings: Accessibility): boolean {
  return (Object.keys(DEFAULT_ACCESSIBILITY) as (keyof Accessibility)[]).some(
    key => settings[key] !== DEFAULT_ACCESSIBILITY[key],
  );
}

export function AccessibilitySection({ platform, autoFocus }: AccessibilitySectionProps) {
  const t = useT();
  const { accessibility, effective, system, set, reset } = useAccessibility();
  const [unsaved, setUnsaved] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const save = (change: Partial<Accessibility>) => setUnsaved(!set(change));

  const followsSystem = accessibility.textScale === 'system';
  const systemScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, system.textScale));
  const step = TEXT_SCALES.indexOf(nearestTextScale(effective.textScale));
  const size = percent(effective.textScale);

  /** Below a switch that follows the system: what the system says, or the way back to it. */
  const origin = (follows: boolean, systemSays: boolean, back: () => void): ReactNode =>
    follows ? (
      <p className="m-0 -mt-2 pb-3.5 text-ui-md text-ui-muted">
        {t(systemSays ? 'settings2.a11y.systemOn' : 'settings2.a11y.systemOff')}
      </p>
    ) : (
      <div className="-mt-2 pb-3.5">
        <Button variant="ghost" className="-ml-4" onClick={back}>
          {t('settings2.a11y.useSystem')}
        </Button>
      </div>
    );

  return (
    <SettingsSection title={t('settings2.a11y.title')} autoFocus={autoFocus}>
      <p className="-mt-2 mb-0 text-ui-md text-ui-muted">{t('settings2.a11y.intro')}</p>

      <div className="flex flex-col gap-3 font-ui">
        <h3 className="m-0 text-ui-lg font-bold text-ui-ink">{t('settings2.a11y.textSize')}</h3>
        <Switch
          label={t('settings2.a11y.textSizeSystem', { n: percent(platform === 'windows' ? systemScale : MIN_SCALE) })}
          description={t(
            platform === 'windows' ? 'settings2.a11y.textSizeSystemWindows' : 'settings2.a11y.textSizeSystemOther',
          )}
          checked={followsSystem}
          onCheckedChange={on => save({ textScale: on ? 'system' : nearestTextScale(effective.textScale) })}
        />
        <div className={cx('flex items-center gap-3', followsSystem && 'opacity-60')}>
          <span aria-hidden="true" className="text-ui-xs font-bold text-ui-ink">
            A
          </span>
          <input
            type="range"
            min={0}
            max={TEXT_SCALES.length - 1}
            step={1}
            value={step}
            aria-label={t('settings2.a11y.textSize')}
            aria-valuetext={t('settings2.a11y.textSizeValueA11y', { n: size })}
            onChange={event => save({ textScale: TEXT_SCALES[Number(event.target.value)] ?? MIN_SCALE })}
            className="min-h-11 min-w-0 flex-1 cursor-pointer accent-ui-accent"
          />
          <span aria-hidden="true" className="text-[1.25rem] font-bold leading-none text-ui-ink">
            A
          </span>
          <span className="min-w-[3.5rem] text-right font-ui-mono text-ui-md text-ui-ink">
            {t('settings2.a11y.textSizeValue', { n: size })}
          </span>
        </div>
        <div
          role="group"
          aria-label={t('settings2.a11y.previewA11y')}
          className="flex w-full max-w-[22.5rem] flex-col gap-2 rounded-ui border border-ui-line bg-ui-bg p-3.5"
        >
          <span className="flex max-w-[85%] flex-col gap-0.5 self-start rounded-ui-bubble border border-ui-bubble-in-line bg-ui-bubble-in px-3 py-2 text-ui-bubble-in-ink">
            <span className="text-ui-base">{t('settings2.appearance.previewIn')}</span>
            <span className="self-end font-ui-mono text-ui-xs text-ui-muted">10:42</span>
          </span>
          <span className="flex max-w-[85%] flex-col gap-0.5 self-end rounded-ui-bubble border border-ui-bubble-me-line bg-ui-bubble-me px-3 py-2 text-ui-bubble-me-ink">
            <span className="text-ui-base">{t('settings2.appearance.previewMe')}</span>
            <span className="flex items-center gap-1 self-end font-ui-mono text-ui-xs text-ui-bubble-me-muted">
              10:43
              <Check {...iconSize('sm')} aria-hidden="true" />
            </span>
          </span>
        </div>
        <p className="m-0 text-ui-md text-ui-muted">{t('settings2.a11y.textSizeHint')}</p>
        <Button variant="ghost" className="-ml-4 self-start" onClick={() => setShortcuts(true)}>
          {t('settings2.a11y.shortcuts')}
        </Button>
      </div>

      <div className="flex flex-col border-t border-ui-line">
        <Switch
          className={ROW}
          label={t('settings2.a11y.vision')}
          description={t('settings2.a11y.visionBody')}
          checked={accessibility.vision === 'safe'}
          onCheckedChange={on => save({ vision: on ? 'safe' : 'standard' })}
        />
        {accessibility.vision === 'safe' ? (
          <ul role="list" aria-label={t('settings2.a11y.legend')} className={cx('m-0 flex list-none flex-col gap-1.5 p-0', ROW)}>
            {LEGEND.map(({ Icon, tone, label }) => (
              <li key={label} className={cx('flex items-center gap-2 font-ui text-ui-md font-semibold', tone)}>
                <Icon {...iconSize('md', 'shrink-0')} aria-hidden="true" />
                {t(label)}
              </li>
            ))}
          </ul>
        ) : null}

        <Switch
          className="py-3.5"
          label={t('settings2.a11y.contrast')}
          description={t('settings2.a11y.contrastBody')}
          checked={effective.contrast === 'more'}
          onCheckedChange={on => save({ contrast: on ? 'more' : 'standard' })}
        />
        <div className="border-b border-ui-line">
          {origin(accessibility.contrast === 'system', system.moreContrast, () => save({ contrast: 'system' }))}
        </div>

        <Switch
          className="py-3.5"
          label={t('settings2.a11y.motion')}
          description={t('settings2.a11y.motionBody')}
          checked={effective.motion === 'reduce'}
          onCheckedChange={on => save({ motion: on ? 'reduce' : 'full' })}
        />
        <div className="border-b border-ui-line">
          {origin(accessibility.motion === 'system', system.reducedMotion, () => save({ motion: 'system' }))}
        </div>

        <Switch
          className={ROW}
          label={t('settings2.a11y.spacing')}
          description={t('settings2.a11y.spacingBody')}
          checked={accessibility.spacing === 'wide'}
          onCheckedChange={on => save({ spacing: on ? 'wide' : 'standard' })}
        />
      </div>

      {differsFromDefaults(accessibility) ? (
        <Button variant="ghost" className="-ml-4 self-start" onClick={() => setUnsaved(!reset())}>
          {t('settings2.a11y.reset')}
        </Button>
      ) : null}
      {unsaved ? <ErrorLine>{t('settings2.a11y.errSave')}</ErrorLine> : null}

      {shortcuts ? <KeyboardShortcutsDialog onClose={() => setShortcuts(false)} /> : null}
    </SettingsSection>
  );
}
