/**
 * The first run of the redesign (R3.5, Onboarding:56-200): the steps of
 * onboarding-machine.ts on screen, with the API injected (plan §3).
 *
 * The machine decides; this runs the commands it asks for, from the event
 * that caused them, never from an effect, so React's double effects in
 * development never call the backend twice. Each new step moves the focus
 * to its heading; an error moves it to the field it is about, or to the
 * message when it is about the whole step.
 *
 * With `api.startConnection` (the network, TOR-6) the "Conexión" step
 * comes after the welcome, and Tor starts only from it.
 *
 * Beyond the contract of types.ts it takes optional stand-ins, for the tests
 * and for the integration: `makeAvatar`, the storage of the consent record,
 * the link opener and the clock. The password never reaches the console.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { THEMES } from '../../../design/tokens';
import { useAppearance } from '../../../design/useAppearance';
import { isCommandError, openLink as openInBrowser } from '../../../lib/api';
import { makeAvatar as makeProfileAvatar } from '../../../lib/avatar';
import { accountPrefsStorage } from '../../../lib/prefs-session';
import { useT } from '../../../lib/i18n';
import { useLang } from '../../../lib/i18n-context';
import { Button } from '../../../ui';
import type { OnboardingFlowProps } from '../../types';
import { attempt } from '../common/attempt';
import { AuthFrame } from '../common/AuthFrame';
import { LABEL_TEXT } from '../common/styles';
import { consentRecord, saveConsentRecord, type ConsentStorage } from './consent';
import {
  INITIAL_ONBOARDING,
  onboardingTransition,
  stepNumber,
  type ErrorField,
  type OnboardingEffect,
  type OnboardingEvent,
  type OnboardingState,
} from './onboarding-machine';
import { StepProgress } from './StepProgress';
import { ConnectionStep } from './steps/ConnectionStep';
import { DoneStep } from './steps/DoneStep';
import { NameStep } from './steps/NameStep';
import { PasswordStep } from './steps/PasswordStep';
import { StyleStep } from './steps/StyleStep';
import { TwofaStep } from './steps/TwofaStep';
import { WelcomeStep } from './steps/WelcomeStep';

export interface OnboardingFlowOptions {
  /** Turns the chosen picture into the profile photo: `makeAvatar` (E0c). */
  makeAvatar?(file: File): Promise<string>;
  /**
   * Where the record of the two boxes is kept: the account's preferences,
   * sealed in the store with the session the new identity opened (cifrado
   * local CL-2a, design H5).
   */
  consentStorage?: ConsentStorage;
  /** Opens the public document in the system browser: `openLink` of api.ts. */
  openLink?(url: string): void;
  /** The clock of the consent record, in ms: `Date.now`. */
  now?(): number;
}

/** A failure for the console: its code, never the backend's whole answer. */
const codeOf = (error: unknown) => (isCommandError(error) ? error.code : 'not a command error');

export function OnboardingFlow({
  api,
  onCreated,
  onVaultExists,
  profileSync = false,
  makeAvatar = makeProfileAvatar,
  consentStorage,
  openLink = openInBrowser,
  now = Date.now,
}: OnboardingFlowProps & OnboardingFlowOptions) {
  const t = useT();
  const { lang } = useLang();
  const { appearance } = useAppearance();
  const headingId = useId();
  const [state, setState] = useState<OnboardingState>(() => ({
    ...INITIAL_ONBOARDING,
    withConnection: api.startConnection !== undefined,
  }));
  const current = useRef(state);
  const mounted = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ageRef = useRef<HTMLInputElement>(null);
  const privacyRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const pass2Ref = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const stepErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = (event: OnboardingEvent) => {
    const { state: next, effects } = onboardingTransition(current.current, event);
    if (next !== current.current) {
      current.current = next;
      if (mounted.current) setState(next);
    }
    effects.forEach(run);
  };

  const run = (effect: OnboardingEffect) => {
    switch (effect.type) {
      case 'startConnection': {
        const start = api.startConnection;
        if (!start) return;
        attempt(() => start(effect.hidden)).then(
          () => send({ type: 'connectionStarted' }),
          (error: unknown) => {
            console.warn('starting Tor failed:', codeOf(error));
            send({ type: 'connectionFailed' });
          },
        );
        return;
      }
      case 'checkPassphrase':
        attempt(() => api.checkPassphrase(effect.passphrase)).then(
          () => send({ type: 'checked' }),
          (error: unknown) => {
            console.warn('check_passphrase failed:', codeOf(error));
            send({ type: 'checkFailed', error });
          },
        );
        return;
      case 'totpBegin':
        attempt(() => api.totpBegin(effect.label)).then(
          enrollment => send({ type: 'enrolled', enrollment }),
          (error: unknown) => {
            console.warn('totp_begin failed:', codeOf(error));
            send({ type: 'enrollFailed', error });
          },
        );
        return;
      case 'totpVerify':
        attempt(() => api.totpVerify(effect.code)).then(
          ok => send({ type: 'verified', ok }),
          (error: unknown) => {
            console.warn('totp_verify failed:', codeOf(error));
            send({ type: 'verifyFailed', error });
          },
        );
        return;
      case 'createIdentity':
        attempt(() => api.createIdentity(effect.handle, effect.passphrase, effect.useTotp)).then(
          response => send({ type: 'created', response }),
          (error: unknown) => {
            console.warn('forge failed:', codeOf(error));
            send({ type: 'createFailed', error });
          },
        );
        return;
      case 'recordConsent': {
        const record = consentRecord({ publicKey: effect.publicKey, lang, at: new Date(now()) });
        if (!saveConsentRecord(consentStorage ?? accountPrefsStorage, record)) {
          console.warn('the record of the age and data boxes could not be kept');
        }
        return;
      }
      case 'saveProfile':
        attempt(() => api.updateProfile(effect.handle, effect.avatar)).then(
          () => send({ type: 'photoSaved' }),
          () => send({ type: 'photoSaveFailed' }),
        );
        return;
      case 'vaultExists':
        onVaultExists();
        return;
    }
  };

  // A new step takes the focus to its heading; an error, to its field, or to
  // the message itself when it is about the whole step.
  const view = `${state.step}:${state.twofa}`;
  const lastView = useRef<string | null>(null);
  useEffect(() => {
    const changed = lastView.current !== view;
    lastView.current = view;
    const target = state.error ? focusTargetOf(state.error.field) : null;
    if (target) target.focus();
    else if (changed) headingRef.current?.focus();
  }, [view, state.error]);

  function focusTargetOf(field: ErrorField): HTMLElement | null {
    switch (field) {
      case 'consent':
        return current.current.ageConfirmed ? privacyRef.current : ageRef.current;
      case 'name':
        return nameRef.current;
      case 'pass':
        return passRef.current;
      case 'pass2':
        return pass2Ref.current;
      case 'code':
        return codeRef.current;
      // The flow disabled the button or the code field that had the focus
      // while it waited, and WebView2 moves the focus off a disabled control
      // to the page, where the next Tab starts again at the window bar.
      case 'step':
        return stepErrorRef.current;
      // Choosing a picture disables nothing: the button that chose it keeps the focus.
      case 'photo':
        return null;
    }
  }

  /** Enter, "Empezar", "Continuar" and "Comprobar". */
  const submit = () => {
    const { step, twofa } = current.current;
    if (step === 'twofa') {
      if (twofa === 'setup') send({ type: 'verify' });
    } else if (step !== 'done') {
      send({ type: 'next' });
    }
  };

  const progress = stepNumber(state);
  const created = state.step === 'done' ? state.created : null;
  const busy = state.busy !== null;
  const withNav = state.step === 'connection' || state.step === 'name' || state.step === 'password' || state.step === 'style';
  const withBack = withNav || (state.step === 'twofa' && state.twofa === 'ask');
  const heading = { headingId, headingRef };

  return (
    <AuthFrame labelledBy={headingId}>
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-ui-display text-[1.25rem] font-bold leading-tight">{THEMES[`${appearance.style}-light`].wordmark}</span>
          {progress ? <span className={LABEL_TEXT}>{t('onb.stepOf', { n: progress.current, total: progress.total })}</span> : null}
        </div>
        {progress ? <StepProgress current={progress.current} total={progress.total} /> : null}

        {state.step === 'welcome' ? (
          <WelcomeStep state={state} send={send} {...heading} ageRef={ageRef} privacyRef={privacyRef} openLink={openLink} />
        ) : null}
        {state.step === 'connection' ? (
          <ConnectionStep state={state} send={send} {...heading} stepErrorRef={stepErrorRef} />
        ) : null}
        {state.step === 'name' ? (
          <NameStep state={state} send={send} {...heading} nameRef={nameRef} profileSync={profileSync} makeAvatar={makeAvatar} />
        ) : null}
        {state.step === 'password' ? (
          <PasswordStep state={state} send={send} {...heading} passRef={passRef} pass2Ref={pass2Ref} />
        ) : null}
        {state.step === 'style' ? <StyleStep {...heading} /> : null}
        {state.step === 'twofa' ? (
          <TwofaStep state={state} send={send} {...heading} codeRef={codeRef} stepErrorRef={stepErrorRef} />
        ) : null}
        {created ? <DoneStep state={state} {...heading} onFinish={intent => onCreated(created, intent)} /> : null}

        {withBack ? (
          <div className="flex flex-wrap justify-between gap-2 pt-1">
            <Button size="lg" disabled={busy} onClick={() => send({ type: 'back' })}>
              {t('onb.back')}
            </Button>
            {withNav ? (
              <Button type="submit" variant="primary" size="lg" loading={state.busy === 'checking' || state.busy === 'connecting'}>
                {state.busy === 'checking' ? t('onb.checking') : t('onb.next')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </AuthFrame>
  );
}
