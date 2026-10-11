/**
 * Step 2 (Onboarding:74-89): the photo and the name. The picture passes
 * through `makeAvatar` (E0c), which makes it small enough for the contacts and
 * drops its metadata; once there is one, "Cambiar foto" goes with "Quitar
 * foto" (plan-cambios-11oct §3.4, 13). The photo is saved once the identity
 * exists. What the text says the contacts get depends on the shared profile
 * (K12, `profileSync`): plan-cambios-11oct §6.
 */
import { useRef, type ChangeEvent, type Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import { identityInitials } from '../../../../lib/initials';
import { Avatar, Button, Field, Input } from '../../../../ui';
import { InlineError } from '../../common/InlineError';
import type { OnboardingEvent, OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

export interface NameStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  nameRef: Ref<HTMLInputElement>;
  profileSync: boolean;
  makeAvatar(file: File): Promise<string>;
}

export function NameStep({ state, send, headingId, headingRef, nameRef, profileSync, makeAvatar }: NameStepProps) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // So the same picture can be chosen again after removing it.
    input.value = '';
    if (!file) return;
    makeAvatar(file).then(
      dataUrl => send({ type: 'photoChosen', dataUrl }),
      () => send({ type: 'photoFailed' }),
    );
  };

  const nameError = state.error?.field === 'name' ? state.error : null;
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        ref={headingRef}
        id={headingId}
        title={t('onb.nameTitle')}
        body={t(profileSync ? 'onb.nameBodySync' : 'onb.nameBody')}
      />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar initials={state.name.trim() ? identityInitials(state.name) : ''} src={state.photo ?? undefined} size={80} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => fileRef.current?.click()}>{t(state.photo ? 'onb.changePhoto' : 'onb.addPhoto')}</Button>
            {state.photo ? (
              <Button variant="ghost" onClick={() => send({ type: 'removePhoto' })}>
                {t('onb.removePhoto')}
              </Button>
            ) : null}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden tabIndex={-1} onChange={choose} />
        </div>
        {state.error?.field === 'photo' ? <InlineError>{t(state.error.key)}</InlineError> : null}
      </div>
      <Field
        label={t('onb.nameLabel')}
        error={nameError ? <span role="alert">{t(nameError.key, nameError.vars)}</span> : undefined}
      >
        <Input
          ref={nameRef}
          value={state.name}
          autoComplete="nickname"
          spellCheck={false}
          onChange={event => send({ type: 'setName', value: event.target.value })}
        />
      </Field>
    </div>
  );
}
