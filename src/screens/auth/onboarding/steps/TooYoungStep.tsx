/**
 * "Menos de 16" (uso responsable UR-10, PropMenoresPC card 2): no account is
 * made, no data is asked for and nothing insists. "Volver al inicio" goes to
 * the welcome, not to the question, so nothing invites another answer.
 */
import type { Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import { Button } from '../../../../ui';
import type { OnboardingEvent } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

export interface TooYoungStepProps {
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
}

export function TooYoungStep({ send, headingId, headingRef }: TooYoungStepProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <StepHeader ref={headingRef} id={headingId} large title={t('onb.youngTitle')} body={t('onb.youngBody')} />
      <p className="m-0 text-ui-base leading-normal text-ui-muted">{t('onb.youngLater')}</p>
      <Button size="lg" onClick={() => send({ type: 'restart' })}>
        {t('onb.youngBack')}
      </Button>
    </div>
  );
}
