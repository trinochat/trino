/**
 * The "Conexión" step (PropTorSimple, card 1; Tor design §9.2, TOR-6):
 * Tor explained once, in plain words, and the option for whoever must not
 * be seen using Trino: "No quiero que mi proveedor note que uso Trino",
 * which starts Tor through a built-in bridge, with its cost in one line.
 * Off by default: most people need no bridge, and it makes the first
 * connection take a minute or two. Tor starts only from this step's
 * "Continuar" (OnboardingFlow), never before.
 */
import type { Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import { Checkbox } from '../../../../ui';
import { InlineError } from '../../common/InlineError';
import type { OnboardingEvent, OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

export interface ConnectionStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  stepErrorRef: Ref<HTMLDivElement>;
}

export function ConnectionStep({ state, send, headingId, headingRef, stepErrorRef }: ConnectionStepProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-[1.125rem]">
      <StepHeader ref={headingRef} id={headingId} title={t('net.welcome.title')} body={t('net.welcome.body')} />
      <Checkbox
        className="rounded-ui-lg border border-ui-line px-3.5"
        label={t('net.welcome.hidden')}
        description={t('net.welcome.hiddenBody')}
        checked={state.hidden}
        disabled={state.busy !== null}
        onChange={event => send({ type: 'setHidden', checked: event.target.checked })}
      />
      {/* It takes the focus, so it is read where the person is, but it is not a Tab stop. */}
      {state.error?.field === 'step' ? (
        <div ref={stepErrorRef} tabIndex={-1} className="outline-none">
          <InlineError>{t(state.error.key)}</InlineError>
        </div>
      ) : null}
    </div>
  );
}
