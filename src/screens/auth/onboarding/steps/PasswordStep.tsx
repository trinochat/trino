/**
 * Step 3 (Onboarding:91-120): the password, its meter, the copy to repeat it
 * and the warning that nobody can recover it. The meter says the level in
 * words and draws it with the number of full bars; the bars are decoration,
 * and under forced colours only the words stay (accesibilidad.md §3.2).
 */
import type { Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import { Banner, Field, PasswordInput, cx } from '../../../../ui';
import type { OnboardingEvent, OnboardingState, UiError } from '../onboarding-machine';
import { STRENGTH_BARS, passphraseStrength, type Strength } from '../passphrase-strength';
import { StepHeader } from './StepHeader';

/** The fill of the full bars, an extra cue beside their number and the words. */
const BAR_FILL: Readonly<Record<Strength, string>> = {
  weak: 'bg-ui-danger',
  fair: 'bg-ui-warn',
  good: 'bg-ui-ok',
  strong: 'bg-ui-ok',
};

export interface PasswordStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  passRef: Ref<HTMLInputElement>;
  pass2Ref: Ref<HTMLInputElement>;
}

export function PasswordStep({ state, send, headingId, headingRef, passRef, pass2Ref }: PasswordStepProps) {
  const t = useT();
  const strength = passphraseStrength(state.pass, { failsPolicy: state.passRejected });
  const busy = state.busy !== null;
  const errorOf = (field: UiError['field']) =>
    state.error?.field === field ? <span role="alert">{t(state.error.key, state.error.vars)}</span> : undefined;

  return (
    <div className="flex flex-col gap-[1.125rem]">
      <StepHeader ref={headingRef} id={headingId} title={t('onb.passTitle')} body={t('onb.passBody')} />
      <Field
        label={t('onb.passLabel')}
        hint={strength ? <StrengthMeter strength={strength} label={t(`onb.strength.${strength}`)} /> : undefined}
        error={errorOf('pass')}
      >
        <PasswordInput
          ref={passRef}
          value={state.pass}
          autoComplete="new-password"
          toggleLabel={t('onb.showPassword')}
          disabled={busy}
          onChange={event => send({ type: 'setPass', value: event.target.value })}
        />
      </Field>
      <Field label={t('onb.pass2Label')} error={errorOf('pass2')}>
        <PasswordInput
          ref={pass2Ref}
          value={state.pass2}
          autoComplete="new-password"
          toggleLabel={t('onb.showPassword')}
          disabled={busy}
          onChange={event => send({ type: 'setPass2', value: event.target.value })}
        />
      </Field>
      <Banner tone="warn">
        <span className="flex flex-col gap-1">
          <strong className="font-bold">{t('onb.noRecoveryTitle')}</strong>
          <span>{t('onb.noRecoveryBody')}</span>
        </span>
      </Banner>
    </div>
  );
}

/** Four bars, as many full as the level, and the level in words. */
function StrengthMeter({ strength, label }: { strength: Strength; label: string }) {
  const full = STRENGTH_BARS[strength];
  return (
    <span className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="mt-1 flex gap-1">
        {[0, 1, 2, 3].map(index => (
          <span
            key={index}
            data-filled={index < full ? '' : undefined}
            className={cx('h-1 flex-1 rounded-full', index < full ? BAR_FILL[strength] : 'bg-ui-line')}
          />
        ))}
      </span>
      <span>{label}</span>
    </span>
  );
}
