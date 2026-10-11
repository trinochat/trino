/**
 * Step 4 (Onboarding:122-142): Calma or Terminal, each with a preview of how
 * it looks, applied as soon as it is picked (useAppearance). The previews
 * draw each style with the accent, the mode and the accessibility layers in
 * effect, so they show what the person is about to get. Their colours are
 * their content, so forced colours leave them alone.
 */
import type { CSSProperties, Ref } from 'react';
import { cssVariables, resolveTokens, type Mode } from '../../../../design/appearance';
import type { ResolvedMode, Style } from '../../../../design/tokens';
import { useAccessibility, useAppearance } from '../../../../design/useAppearance';
import { useT } from '../../../../lib/i18n';
import { ChoiceDot, ChoiceGroup, type ChoiceOption } from '../ChoiceGroup';
import { StepHeader } from './StepHeader';

export interface StyleStepProps {
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
}

export function StyleStep({ headingId, headingRef }: StyleStepProps) {
  const t = useT();
  const { appearance, setAppearance } = useAppearance();
  const options: ChoiceOption<Style>[] = [
    { value: 'calma', label: 'Calma', description: t('onb.calmaDesc') },
    { value: 'terminal', label: 'Terminal', description: t('onb.terminalDesc') },
  ];
  return (
    <div className="flex flex-col gap-[1.125rem]">
      <StepHeader ref={headingRef} id={headingId} title={t('onb.styleTitle')} body={t('onb.styleBody')} />
      <ChoiceGroup
        aria-labelledby={headingId}
        options={options}
        value={appearance.style}
        onValueChange={style => setAppearance({ ...appearance, style })}
        className="flex flex-wrap gap-3"
        itemClassName="flex min-w-0 flex-[1_1_12.5rem] flex-col gap-2.5 rounded-ui-lg bg-ui-surface p-3 text-left"
        renderItem={(option, { checked, labelId, descriptionId }) => (
          <>
            <StylePreview style={option.value} />
            <span className="flex items-center gap-2">
              <ChoiceDot checked={checked} />
              <span id={labelId} className="text-ui-lg font-bold">
                {option.label}
              </span>
            </span>
            <span id={descriptionId} className="text-ui-md leading-[1.45] text-ui-muted">
              {option.description}
            </span>
          </>
        )}
      />
    </div>
  );
}

/** The mode on screen: the chosen one, or what the system says (set on <html> by apply.ts). */
function resolvedMode(mode: Mode): ResolvedMode {
  if (mode !== 'system') return mode;
  return document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
}

/**
 * A small chat in one style (Onboarding:131-135): its own `--t-*` variables
 * on the box, so the token classes inside draw that style.
 */
function StylePreview({ style }: { style: Style }) {
  const t = useT();
  const { appearance } = useAppearance();
  const { effective, scanLines } = useAccessibility();
  const tokens = resolveTokens(style, resolvedMode(appearance.mode), appearance.accent, {
    vision: effective.vision,
    contrast: effective.contrast,
    scanLines,
  });
  return (
    <span
      aria-hidden="true"
      data-preview={style}
      style={cssVariables(tokens) as CSSProperties}
      className="flex min-h-[7rem] w-full flex-col gap-1.5 rounded-ui border border-ui-line bg-ui-bg p-2.5 font-ui [background-image:var(--t-scan)] [forced-color-adjust:none]"
    >
      <span className="font-ui-display text-ui-sm font-bold text-ui-ink">{tokens.wordmark}</span>
      <span className="self-start rounded-ui-bubble border border-ui-bubble-in-line bg-ui-bubble-in px-2 py-1 text-ui-xs text-ui-bubble-in-ink">
        {t('onb.previewIn')}
      </span>
      <span className="self-end rounded-ui-bubble border border-ui-bubble-me-line bg-ui-bubble-me px-2 py-1 text-ui-xs text-ui-bubble-me-ink">
        {t('onb.previewOut')}
      </span>
    </span>
  );
}
