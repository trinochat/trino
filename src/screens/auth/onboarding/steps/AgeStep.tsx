/**
 * "¿Cuántos años tienes?" (uso responsable UR-10, PropMenoresPC card 1;
 * minimum of 16, David, 25 Oct): after the welcome and before the name, one
 * question with three answers and none chosen; "Continuar" waits for one.
 * No document, birth date or photo, and the answer stays on this device.
 * With "16 o 17", the line that the account starts closed and where it is
 * corrected. "Menos de 16" leads to its own screen (`TooYoungStep`).
 */
import type { Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import { RadioCardGroup } from '../../../../ui';
import { InlineError } from '../../common/InlineError';
import type { AgeAnswer, OnboardingEvent, OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

export interface AgeStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
}

const ANSWERS: readonly [AgeAnswer, string][] = [
  ['under16', 'onb.ageUnder16'],
  ['minor', 'onb.ageMinor'],
  ['adult', 'onb.ageAdult'],
];

export function AgeStep({ state, send, headingId, headingRef }: AgeStepProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <StepHeader ref={headingRef} id={headingId} title={t('onb.ageTitle')} body={t('onb.ageBody')} />
      <RadioCardGroup
        aria-labelledby={headingId}
        options={ANSWERS.map(([value, label]) => ({ value, label: t(label) }))}
        value={state.age}
        onValueChange={answer => send({ type: 'setAge', answer })}
      />
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('onb.ageNote')}</p>
      {state.age === 'minor' ? (
        <p className="m-0 rounded-ui bg-ui-accent-soft px-3.5 py-3 text-ui-md leading-normal text-ui-ink">
          {t('onb.ageMinorNote')}
        </p>
      ) : null}
      {state.error?.field === 'age' ? <InlineError>{t(state.error.key)}</InlineError> : null}
    </div>
  );
}
