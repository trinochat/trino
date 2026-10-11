/**
 * Step 5 (Onboarding:144-172): two-step verification, optional. First the
 * question, "Activar" or "Ahora no", which creates the identity without it.
 * "Activar" shows the code to scan, the key to type when scanning is not
 * possible, and the field for the 6 digits; a right code creates the
 * identity with it. The QR stays black on white in every theme and under
 * forced colours (QR_FRAME).
 */
import { QRCodeSVG } from 'qrcode.react';
import { useId, useState, type Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import { Banner, Button, FOCUS_RING, Field, Input, QR_FRAME, cx } from '../../../../ui';
import { LINK_TEXT } from '../../common/styles';
import type { OnboardingEvent, OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

export interface TwofaStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  codeRef: Ref<HTMLInputElement>;
  /** The message of a failure about the whole step, which takes the focus (OnboardingFlow). */
  stepErrorRef: Ref<HTMLDivElement>;
}

export function TwofaStep({ state, send, headingId, headingRef, codeRef, stepErrorRef }: TwofaStepProps) {
  const t = useT();
  const busy = state.busy !== null;
  // It takes the focus, so it is read where the person is, but it is not a Tab stop.
  const stepError =
    state.error?.field === 'step' ? (
      <div ref={stepErrorRef} tabIndex={-1} className="outline-none">
        <Banner tone="danger">{t(state.error.key)}</Banner>
      </div>
    ) : null;
  // There from the start, so "Creando tu identidad…" is announced when it appears.
  const creating = (
    <p role="status" className="m-0 text-ui-md text-ui-muted">
      {state.busy === 'creating' ? t('onb.creating') : ''}
    </p>
  );

  if (state.twofa === 'ask' || state.enrollment === null) {
    return (
      <div className="flex flex-col gap-[1.125rem]">
        <StepHeader ref={headingRef} id={headingId} title={t('onb.twofaTitle')} body={t('onb.twofaBody')} />
        {stepError}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="lg"
            className="flex-[1_1_10rem]"
            loading={state.busy === 'enrolling'}
            disabled={busy}
            onClick={() => send({ type: 'activate' })}
          >
            {t('onb.twofaOn')}
          </Button>
          <Button
            size="lg"
            className="flex-[1_1_10rem]"
            loading={state.busy === 'creating'}
            disabled={busy}
            onClick={() => send({ type: 'later' })}
          >
            {t('onb.twofaLater')}
          </Button>
        </div>
        {creating}
      </div>
    );
  }

  const codeError = state.error?.field === 'code' ? <span role="alert">{t(state.error.key)}</span> : undefined;
  return (
    <div className="flex flex-col gap-[1.125rem]">
      <StepHeader ref={headingRef} id={headingId} title={t('onb.twofaTitle')} body={t('onb.twofaScan')} />
      <div className="flex flex-wrap items-center gap-5">
        <div role="img" aria-label={t('onb.twofaQr')} className={cx(QR_FRAME, 'w-[10.5rem] shrink-0')}>
          <QRCodeSVG
            value={state.enrollment.otpauth_uri}
            size={160}
            fgColor="currentColor"
            bgColor="transparent"
            className="h-full w-full"
            aria-hidden="true"
          />
        </div>
        <Field label={t('onb.twofaCode')} error={codeError} className="min-w-0 flex-[1_1_12.5rem]">
          <Input
            ref={codeRef}
            mono
            value={state.code}
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={busy}
            className="text-[1.25rem] tracking-[0.12em]"
            onChange={event => send({ type: 'setCode', value: event.target.value })}
          />
        </Field>
      </div>
      <ManualKey secret={state.enrollment.secret_base32} />
      {stepError}
      <Button type="submit" variant="primary" size="lg" fullWidth loading={state.busy === 'verifying' || state.busy === 'creating'}>
        {t('onb.verify')}
      </Button>
      <Button variant="ghost" className="self-center" disabled={busy} onClick={() => send({ type: 'back' })}>
        {t('onb.twofaBack')}
      </Button>
      {creating}
    </div>
  );
}

/** The secret in groups of four, as authenticator apps show it. */
const inGroupsOfFour = (secret: string) => secret.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? '';

/** "¿No puedes escanear? Escribe esta clave": the secret behind a toggle, to type it in by hand. */
function ManualKey({ secret }: { secret: string }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(shown => !shown)}
        className={cx('min-h-11 self-start rounded-ui text-left text-ui-md', LINK_TEXT, FOCUS_RING)}
      >
        {t('onb.twofaManual')}
      </button>
      <code
        id={id}
        hidden={!open}
        className="select-all rounded-ui bg-ui-raised px-3 py-2 font-ui-mono text-ui-base tracking-[0.08em] text-ui-ink [overflow-wrap:anywhere]"
      >
        {inGroupsOfFour(secret)}
      </code>
    </div>
  );
}
