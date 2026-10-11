/**
 * Settings > Apariencia (Settings:200-232, accesibilidad.md §3.2 and §5.1):
 * the style, Calma or Terminal, each shown as itself; light, dark or like the
 * system (deviation 4 of plan §1.8); the accent, whose name is written out
 * beside the swatches, since a swatch is only colour; and, with Terminal,
 * its scan lines. The text size moved to Accesibilidad.
 *
 * The style previews are drawn with `resolveTokens` and the vision, contrast
 * and scan lines in effect, so they show what the person will see. Their
 * colours are content, so forced colours leave them alone, as they do the
 * swatches.
 */
import { Check } from 'lucide-react';
import { useId, useState } from 'react';
import { resolveTokens, type Accent, type Mode, type Style } from '../../../design/appearance';
import { ACCENTS, STYLES, type ResolvedMode } from '../../../design/tokens';
import { useAccessibility, useAppearance } from '../../../design/useAppearance';
import { useT } from '../../../lib/i18n';
import { cx, FOCUS_RING, iconSize, Segmented, Switch } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { SettingsSection } from '../SettingsSection';

const STYLE_KEYS: Record<Style, string> = { calma: 'settings2.appearance.calma', terminal: 'settings2.appearance.terminal' };
const MODE_KEYS: Record<Mode, string> = {
  light: 'settings2.appearance.light',
  dark: 'settings2.appearance.dark',
  system: 'settings2.appearance.system',
};
const ACCENT_KEYS: Record<Accent, string> = {
  verde: 'settings2.appearance.accentVerde',
  azul: 'settings2.appearance.accentAzul',
  morado: 'settings2.appearance.accentMorado',
  naranja: 'settings2.appearance.accentNaranja',
};

/** The mode on screen now: `apply.ts` marks it on <html>, `system` resolved. */
function resolvedMode(): ResolvedMode {
  return document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
}

export function AppearanceSection({ autoFocus }: { autoFocus?: boolean }) {
  const t = useT();
  const { appearance, setAppearance } = useAppearance();
  const { effective, scanLines, setScanLines } = useAccessibility();
  const [unsaved, setUnsaved] = useState(false);
  const accentHeadingId = useId();
  const modeHeadingId = useId();
  const mode = resolvedMode();
  const layers = { vision: effective.vision, contrast: effective.contrast, scanLines };

  const change = (next: Partial<typeof appearance>) => setUnsaved(!setAppearance({ ...appearance, ...next }));

  return (
    <SettingsSection title={t('settings2.appearance.title')} autoFocus={autoFocus}>
      <div role="group" aria-label={t('settings2.appearance.style')} className="flex flex-wrap gap-3">
        {STYLES.map(style => {
          const pressed = appearance.style === style;
          const k = resolveTokens(style, mode, appearance.accent, layers);
          return (
            <button
              key={style}
              type="button"
              aria-pressed={pressed}
              onClick={() => change({ style })}
              className={cx(
                'flex min-w-0 flex-[1_1_12.5rem] flex-col gap-2 rounded-ui-lg border-2 bg-ui-surface p-3 text-left font-ui text-ui-ink',
                pressed ? 'border-ui-accent-text forced-colors:border-[color:Highlight]' : 'border-ui-line',
                FOCUS_RING,
              )}
            >
              <span
                aria-hidden="true"
                data-preview={style}
                data-vision={effective.vision}
                data-contrast={effective.contrast}
                className="flex min-h-[4.5rem] flex-col justify-center gap-1.5 border px-2.5 py-2 [forced-color-adjust:none]"
                style={{
                  backgroundColor: k.bg,
                  backgroundImage: k.scan === 'none' ? undefined : k.scan,
                  borderColor: k.line,
                  borderRadius: k.radius,
                }}
              >
                <span
                  data-bubble="in"
                  className="self-start border px-2 py-1 text-ui-xs"
                  style={{
                    backgroundColor: k.bubbleIn,
                    color: k.bubbleInInk,
                    borderColor: k.bubbleInLine,
                    borderRadius: k.bubbleRadius,
                    fontFamily: k.font,
                  }}
                >
                  {t('settings2.appearance.sampleIn')}
                </span>
                <span
                  data-bubble="me"
                  className="self-end border px-2 py-1 text-ui-xs"
                  style={{
                    backgroundColor: k.bubbleMe,
                    color: k.bubbleMeInk,
                    borderColor: k.bubbleMeLine,
                    borderRadius: k.bubbleRadius,
                    fontFamily: k.font,
                  }}
                >
                  {t('settings2.appearance.sampleMe')}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-ui-base font-bold">
                {pressed ? <Check {...iconSize('md', 'shrink-0 text-ui-accent-text')} aria-hidden="true" /> : null}
                {t(STYLE_KEYS[style])}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span id={modeHeadingId} className="font-ui text-ui-lg font-bold text-ui-ink">
          {t('settings2.appearance.mode')}
        </span>
        <Segmented<Mode>
          aria-labelledby={modeHeadingId}
          value={appearance.mode}
          onValueChange={value => change({ mode: value })}
          options={(['light', 'dark', 'system'] as const).map(value => ({ value, label: t(MODE_KEYS[value]) }))}
          className="self-start"
        />
      </div>

      <div role="group" aria-labelledby={accentHeadingId} className="flex flex-col gap-2.5 font-ui">
        <span id={accentHeadingId} className="text-ui-lg font-bold text-ui-ink">
          {t('settings2.appearance.accent')}
        </span>
        <span className="text-ui-md text-ui-muted">{t('settings2.appearance.accentBody')}</span>
        <div className="flex flex-wrap items-center gap-2.5">
          {ACCENTS.map(accent => {
            const pressed = appearance.accent === accent;
            const swatch = resolveTokens(appearance.style, mode, accent, layers);
            return (
              <button
                key={accent}
                type="button"
                aria-label={t(ACCENT_KEYS[accent])}
                aria-pressed={pressed}
                onClick={() => change({ accent })}
                className={cx(
                  'inline-flex h-11 w-11 items-center justify-center rounded-full border-[3px] [forced-color-adjust:none]',
                  FOCUS_RING,
                )}
                style={{
                  backgroundColor: swatch.accent,
                  borderColor: pressed ? swatch.ink : 'transparent',
                  color: swatch.accentInk,
                }}
              >
                {pressed ? <Check {...iconSize('lg')} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
        <span className="text-ui-md font-semibold text-ui-ink">
          {t('settings2.appearance.accentChosen', { name: t(ACCENT_KEYS[appearance.accent]) })}
        </span>
        <div aria-hidden="true" className="flex w-full max-w-[22.5rem] flex-col gap-2 rounded-ui border border-ui-line bg-ui-bg p-3.5">
          <span className="self-start rounded-ui-bubble border border-ui-bubble-in-line bg-ui-bubble-in px-3 py-2 text-ui-md text-ui-bubble-in-ink">
            {t('settings2.appearance.previewIn')}
          </span>
          <span className="self-end rounded-ui-bubble border border-ui-bubble-me-line bg-ui-bubble-me px-3 py-2 text-ui-md text-ui-bubble-me-ink">
            {t('settings2.appearance.previewMe')}
          </span>
          <span className="inline-flex min-h-9 items-center self-start rounded-ui bg-ui-accent px-3.5 text-ui-md font-bold text-ui-accent-ink">
            {t('settings2.appearance.previewButton')}
          </span>
        </div>
      </div>

      {appearance.style === 'terminal' ? (
        <Switch
          className="border-y border-ui-line py-3.5"
          label={t('settings2.appearance.scanLines')}
          description={t('settings2.appearance.scanLinesBody')}
          checked={scanLines}
          onCheckedChange={on => setUnsaved(!setScanLines(on))}
        />
      ) : null}

      {unsaved ? <ErrorLine>{t('settings2.appearance.errSave')}</ErrorLine> : null}
    </SettingsSection>
  );
}
