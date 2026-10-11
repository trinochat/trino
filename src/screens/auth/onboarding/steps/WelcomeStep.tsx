/**
 * Step 1 (Onboarding:56-72): the welcome, the language, which applies at
 * once, and the two boxes the parent's addendum asks for (David, 11 Oct
 * 2026), both unticked and both required: "Tengo 18 años o más" and "Leí y
 * acepto cómo Trino trata mis datos", with the link to the public document.
 * Without them "Empezar" says why and goes back to the first unticked box.
 */
import { ExternalLink } from 'lucide-react';
import { useId, type Ref } from 'react';
import { LANGS, useT, type Lang } from '../../../../lib/i18n';
import { useLang } from '../../../../lib/i18n-context';
import { Button, Checkbox, FOCUS_RING, cx, iconSize } from '../../../../ui';
import { InlineError } from '../../common/InlineError';
import { LINK_TEXT } from '../../common/styles';
import { ChoiceDot, ChoiceGroup, type ChoiceOption } from '../ChoiceGroup';
import { PRIVACY_POLICY_URL } from '../consent';
import type { OnboardingEvent, OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

/** Each language in its own words, marked as such for screen readers. */
const LANGUAGES: readonly ChoiceOption<Lang>[] = LANGS.map(({ code, label }) => ({ value: code, label, lang: code }));

export interface WelcomeStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  ageRef: Ref<HTMLInputElement>;
  privacyRef: Ref<HTMLInputElement>;
  /** Opens the public document in the system browser. */
  openLink(url: string): void;
}

export function WelcomeStep({ state, send, headingId, headingRef, ageRef, privacyRef, openLink }: WelcomeStepProps) {
  const t = useT();
  const { lang, setLang } = useLang();
  const languageLabelId = useId();
  const errorId = useId();
  const refused = state.error?.field === 'consent';
  /** Once "Empezar" was refused, each unticked box says so and points at why. */
  const boxState = (ticked: boolean) => (refused ? { 'aria-describedby': errorId, 'aria-invalid': ticked ? undefined : true } : {});

  return (
    <div className="flex flex-col gap-5">
      <StepHeader ref={headingRef} id={headingId} large title={t('onb.welcomeTitle')} body={t('onb.welcomeBody')} />
      <div className="flex flex-col gap-2">
        <span id={languageLabelId} className="text-ui-base font-semibold">
          {t('onb.langLabel')}
        </span>
        <ChoiceGroup
          aria-labelledby={languageLabelId}
          options={LANGUAGES}
          value={lang}
          onValueChange={setLang}
          className="flex flex-wrap gap-2"
          itemClassName="flex min-h-12 min-w-0 flex-[1_1_8.75rem] items-center gap-3 rounded-ui px-3.5 text-left text-ui-base font-semibold"
          checkedClassName="bg-ui-accent-soft"
          renderItem={(option, { checked, labelId }) => (
            <>
              <ChoiceDot checked={checked} />
              <span id={labelId}>{option.label}</span>
            </>
          )}
        />
      </div>
      <div className="flex flex-col">
        <Checkbox
          ref={ageRef}
          label={t('onb.ageLabel')}
          checked={state.ageConfirmed}
          onChange={event => send({ type: 'setAge', checked: event.target.checked })}
          {...boxState(state.ageConfirmed)}
        />
        <Checkbox
          ref={privacyRef}
          label={t('onb.privacyLabel')}
          checked={state.privacyAccepted}
          onChange={event => send({ type: 'setPrivacy', checked: event.target.checked })}
          {...boxState(state.privacyAccepted)}
        />
        <a
          href={PRIVACY_POLICY_URL}
          onClick={event => {
            event.preventDefault();
            openLink(PRIVACY_POLICY_URL);
          }}
          className={cx('ms-8 inline-flex min-h-11 items-center gap-1.5 self-start rounded-ui text-ui-md', LINK_TEXT, FOCUS_RING)}
        >
          {t('onb.privacyLink')}
          <ExternalLink aria-hidden="true" {...iconSize('sm', 'shrink-0')} />
        </a>
        {refused ? <InlineError id={errorId}>{t('onb.errConsent')}</InlineError> : null}
      </div>
      <Button type="submit" variant="primary" size="lg" fullWidth>
        {t('onb.start')}
      </Button>
    </div>
  );
}
