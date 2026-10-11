/**
 * The first run as a pure state machine (plan §3 W1): the steps of
 * Onboarding:56-200, what each one checks before going on, and what the flow
 * does with every answer of the backend. It calls nothing itself: a
 * transition returns the commands to run as `effects`, and OnboardingFlow runs
 * them from the event that caused them, so React's double effects in
 * development never create an identity twice.
 *
 * Steps: welcome (language and the two boxes) → name and photo → password →
 * style → the 2FA question, and its setup → "Todo listo". Back goes one step
 * back, also from the 2FA question to the style (plan §1.8, 8).
 */
import type { ForgeResponse, TotpBeginResponse } from '../../../lib/api';
import type { TVars } from '../../../lib/i18n';
import { onboardingFailure } from './errors';

/** The longest name, in Unicode scalars (plan-cambios-11oct §4, W1). */
export const NAME_MAX = 40;
const CODE_DIGITS = 6;

/** The steps of the progress bar, in order: "Paso n de 5". "Todo listo" has none. */
export const PROGRESS_STEPS = ['welcome', 'name', 'password', 'style', 'twofa'] as const;
export type OnboardingStep = (typeof PROGRESS_STEPS)[number] | 'done';
/** The 2FA step asks first; "Activar" sets it up. */
export type TwofaView = 'ask' | 'setup';
/** What the flow waits for. */
export type Busy = 'checking' | 'enrolling' | 'verifying' | 'creating';

/** Where an error shows: next to a field, by the two boxes, or for the whole step. */
export type ErrorField = 'consent' | 'name' | 'photo' | 'pass' | 'pass2' | 'code' | 'step';
export interface UiError {
  field: ErrorField;
  key: string;
  vars?: TVars;
}

export interface OnboardingState {
  step: OnboardingStep;
  twofa: TwofaView;
  /** "Tengo 18 años o más". */
  ageConfirmed: boolean;
  /** "Leí y acepto cómo Trino trata mis datos". */
  privacyAccepted: boolean;
  /** As typed; trimmed when it is checked and sent. */
  name: string;
  /** The photo from `makeAvatar`, saved once the identity exists. */
  photo: string | null;
  pass: string;
  pass2: string;
  /** The policy called this password too common: the meter says weak until it changes. */
  passRejected: boolean;
  /** The 2FA code as typed. */
  code: string;
  /** The TOTP secret of `totpBegin`, kept so the scanned code stays valid. */
  enrollment: TotpBeginResponse | null;
  /** The backend confirmed a code of this enrollment. */
  totpVerified: boolean;
  busy: Busy | null;
  error: UiError | null;
  /** The identity, once created. */
  created: ForgeResponse | null;
  photoSave: 'idle' | 'saving' | 'saved' | 'failed';
}

export type OnboardingEvent =
  | { type: 'setAge'; checked: boolean }
  | { type: 'setPrivacy'; checked: boolean }
  | { type: 'setName'; value: string }
  | { type: 'photoChosen'; dataUrl: string }
  | { type: 'photoFailed' }
  | { type: 'removePhoto' }
  | { type: 'setPass'; value: string }
  | { type: 'setPass2'; value: string }
  | { type: 'setCode'; value: string }
  /** "Empezar" or "Continuar". */
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'checked' }
  | { type: 'checkFailed'; error: unknown }
  /** "Activar". */
  | { type: 'activate' }
  | { type: 'enrolled'; enrollment: TotpBeginResponse }
  | { type: 'enrollFailed'; error: unknown }
  /** "Ahora no": create the identity without 2FA. */
  | { type: 'later' }
  /** "Comprobar". */
  | { type: 'verify' }
  | { type: 'verified'; ok: boolean }
  | { type: 'verifyFailed'; error: unknown }
  | { type: 'created'; response: ForgeResponse }
  | { type: 'createFailed'; error: unknown }
  | { type: 'photoSaved' }
  | { type: 'photoSaveFailed' };

/** The commands a transition asks the flow to run, with what they need. */
export type OnboardingEffect =
  | { type: 'checkPassphrase'; passphrase: string }
  | { type: 'totpBegin'; label: string }
  | { type: 'totpVerify'; code: string }
  | { type: 'createIdentity'; handle: string; passphrase: string; useTotp: boolean }
  /** Keep the record of the two boxes, with the new identity's public key. */
  | { type: 'recordConsent'; publicKey: string }
  /** The photo is saved after the identity exists: `forge` takes none. */
  | { type: 'saveProfile'; handle: string; avatar: string }
  /** There is an identity on this device already: the parent takes over. */
  | { type: 'vaultExists' };

export interface Transition {
  state: OnboardingState;
  effects: OnboardingEffect[];
}

export const INITIAL_ONBOARDING: OnboardingState = Object.freeze({
  step: 'welcome',
  twofa: 'ask',
  ageConfirmed: false,
  privacyAccepted: false,
  name: '',
  photo: null,
  pass: '',
  pass2: '',
  passRejected: false,
  code: '',
  enrollment: null,
  totpVerified: false,
  busy: null,
  error: null,
  created: null,
  photoSave: 'idle',
}) as OnboardingState;

/** "Paso n de 5", or null on "Todo listo". */
export function stepNumber(state: OnboardingState): { current: number; total: number } | null {
  if (state.step === 'done') return null;
  return { current: PROGRESS_STEPS.indexOf(state.step) + 1, total: PROGRESS_STEPS.length };
}

/**
 * A fresh object for each refusal, so the flow sees a new error and takes the
 * focus again to the first unticked box.
 */
const consentError = (): UiError => ({ field: 'consent', key: 'onb.errConsent' });

const stay = (state: OnboardingState): Transition => ({ state, effects: [] });
const go = (state: OnboardingState, ...effects: OnboardingEffect[]): Transition => ({ state, effects });

/** Both boxes of the welcome step are ticked: the only way on (consent.ts). */
function consentGiven(state: OnboardingState): boolean {
  return state.ageConfirmed && state.privacyAccepted;
}

/** The name's problem, or null: trimmed, at least one and at most NAME_MAX scalars. */
function nameError(name: string): UiError | null {
  const trimmed = name.trim();
  if (trimmed === '') return { field: 'name', key: 'onb.errNameRequired' };
  if ([...trimmed].length > NAME_MAX) return { field: 'name', key: 'onb.errNameTooLong', vars: { max: NAME_MAX } };
  return null;
}

/**
 * Asks the backend to create the identity, once both boxes are ticked and the
 * name is fine; otherwise back to the step that says why. This guards every
 * way to `createIdentity`, whatever happened before.
 */
function create(state: OnboardingState, useTotp: boolean): Transition {
  if (!consentGiven(state)) return stay({ ...state, step: 'welcome', twofa: 'ask', busy: null, error: consentError() });
  const badName = nameError(state.name);
  if (badName) return stay({ ...state, step: 'name', twofa: 'ask', busy: null, error: badName });
  return go(
    { ...state, busy: 'creating', error: null },
    { type: 'createIdentity', handle: state.name.trim(), passphrase: state.pass, useTotp },
  );
}

const PREVIOUS: Partial<Record<OnboardingStep, OnboardingStep>> = {
  name: 'welcome',
  password: 'name',
  style: 'password',
  twofa: 'style',
};

function next(state: OnboardingState): Transition {
  switch (state.step) {
    case 'welcome':
      return consentGiven(state) ? stay({ ...state, step: 'name', error: null }) : stay({ ...state, error: consentError() });
    case 'name': {
      const error = nameError(state.name);
      return stay(error ? { ...state, error } : { ...state, step: 'password', error: null });
    }
    case 'password':
      return go({ ...state, busy: 'checking', error: null }, { type: 'checkPassphrase', passphrase: state.pass });
    case 'style':
      return stay({ ...state, step: 'twofa', twofa: 'ask', error: null });
    default:
      return stay(state);
  }
}

function back(state: OnboardingState): Transition {
  if (state.step === 'twofa' && state.twofa === 'setup') return stay({ ...state, twofa: 'ask', error: null });
  const previous = PREVIOUS[state.step];
  return previous ? stay({ ...state, step: previous, twofa: 'ask', error: null }) : stay(state);
}

/** The policy agreed: the two passwords must also match. */
function passwordChecked(state: OnboardingState): Transition {
  if (state.pass2 !== state.pass) return stay({ ...state, busy: null, error: { field: 'pass2', key: 'onb.errMismatch' } });
  return stay({ ...state, step: 'style', busy: null, error: null });
}

/** What a policy rejection does to the password step, or null for any other failure. */
function policyRejection(state: OnboardingState, error: unknown): OnboardingState | null {
  const failure = onboardingFailure(error);
  if (failure.kind === 'tooShort') {
    return { ...state, step: 'password', twofa: 'ask', busy: null, error: { field: 'pass', key: 'onb.errTooShort', vars: { min: failure.min } } };
  }
  if (failure.kind === 'tooCommon') {
    return { ...state, step: 'password', twofa: 'ask', busy: null, passRejected: true, error: { field: 'pass', key: 'onb.errTooCommon' } };
  }
  return null;
}

function verify(state: OnboardingState): Transition {
  if (state.totpVerified) return create(state, true);
  const digits = state.code.replace(/\D/g, '');
  if (digits.length !== CODE_DIGITS) return stay({ ...state, error: { field: 'code', key: 'onb.errCodeLength' } });
  return go({ ...state, busy: 'verifying', error: null }, { type: 'totpVerify', code: digits });
}

function created(state: OnboardingState, response: ForgeResponse): Transition {
  const effects: OnboardingEffect[] = [{ type: 'recordConsent', publicKey: response.nostr_pub }];
  if (state.photo !== null) effects.push({ type: 'saveProfile', handle: response.handle, avatar: state.photo });
  return go(
    {
      ...state,
      step: 'done',
      created: response,
      busy: null,
      error: null,
      // Nothing secret stays in memory once the identity exists.
      pass: '',
      pass2: '',
      code: '',
      enrollment: null,
      photoSave: state.photo !== null ? 'saving' : 'idle',
    },
    ...effects,
  );
}

function createFailed(state: OnboardingState, error: unknown): Transition {
  const rejected = policyRejection(state, error);
  if (rejected) return stay(rejected);
  const failure = onboardingFailure(error);
  if (failure.kind === 'totpNotVerified') {
    return stay({
      ...state,
      step: 'twofa',
      twofa: 'setup',
      busy: null,
      totpVerified: false,
      code: '',
      error: { field: 'code', key: 'onb.errTotpNotVerified' },
    });
  }
  if (failure.kind === 'vaultExists') return go({ ...state, busy: null }, { type: 'vaultExists' });
  return stay({ ...state, busy: null, error: { field: 'step', key: 'onb.errCreate' } });
}

/** The person's own events, which wait while the flow waits for the backend. */
function personEvent(state: OnboardingState, event: OnboardingEvent): Transition {
  switch (event.type) {
    case 'setAge':
    case 'setPrivacy': {
      const ticked =
        event.type === 'setAge'
          ? { ...state, ageConfirmed: event.checked }
          : { ...state, privacyAccepted: event.checked };
      const clear = ticked.error?.field === 'consent' && consentGiven(ticked);
      return stay(clear ? { ...ticked, error: null } : ticked);
    }
    case 'setName':
      return stay({ ...state, name: event.value, error: state.error?.field === 'name' ? null : state.error });
    case 'setPass': {
      const cleared = state.error?.field === 'pass' || state.error?.field === 'pass2' ? null : state.error;
      return stay({ ...state, pass: event.value, passRejected: false, error: cleared });
    }
    case 'setPass2':
      return stay({ ...state, pass2: event.value, error: state.error?.field === 'pass2' ? null : state.error });
    case 'setCode':
      return stay({ ...state, code: event.value, error: state.error?.field === 'code' ? null : state.error });
    case 'next':
      return next(state);
    case 'back':
      return back(state);
    case 'activate':
      if (state.step !== 'twofa' || state.twofa !== 'ask') return stay(state);
      if (state.enrollment) return stay({ ...state, twofa: 'setup', error: null });
      return go({ ...state, busy: 'enrolling', error: null }, { type: 'totpBegin', label: state.name.trim() });
    case 'later':
      return state.step === 'twofa' && state.twofa === 'ask' ? create(state, false) : stay(state);
    case 'verify':
      return state.step === 'twofa' && state.twofa === 'setup' ? verify(state) : stay(state);
    default:
      return stay(state);
  }
}

export function onboardingTransition(state: OnboardingState, event: OnboardingEvent): Transition {
  switch (event.type) {
    // The photo comes from makeAvatar, which may answer after a step change.
    case 'photoChosen':
      return state.step === 'done' ? stay(state) : stay({ ...state, photo: event.dataUrl, error: state.error?.field === 'photo' ? null : state.error });
    case 'photoFailed':
      return state.step === 'done' ? stay(state) : stay({ ...state, error: { field: 'photo', key: 'onb.errPhoto' } });
    case 'removePhoto':
      return state.step === 'done' ? stay(state) : stay({ ...state, photo: null, error: state.error?.field === 'photo' ? null : state.error });

    // The backend's answers count only while the flow waits for them.
    case 'checked':
      return state.busy === 'checking' ? passwordChecked(state) : stay(state);
    case 'checkFailed':
      return state.busy === 'checking' ? stay(policyRejection(state, event.error) ?? passwordChecked(state).state) : stay(state);
    case 'enrolled':
      return state.busy === 'enrolling'
        ? stay({ ...state, busy: null, enrollment: event.enrollment, twofa: 'setup', code: '', error: null })
        : stay(state);
    case 'enrollFailed':
      return state.busy === 'enrolling' ? stay({ ...state, busy: null, error: { field: 'step', key: 'onb.errTotpBegin' } }) : stay(state);
    case 'verified':
      if (state.busy !== 'verifying') return stay(state);
      return event.ok
        ? create({ ...state, busy: null, totpVerified: true }, true)
        : stay({ ...state, busy: null, error: { field: 'code', key: 'onb.errCode' } });
    case 'verifyFailed':
      return state.busy === 'verifying' ? stay({ ...state, busy: null, error: { field: 'code', key: 'onb.errTotpCheck' } }) : stay(state);
    case 'created':
      return state.busy === 'creating' ? created(state, event.response) : stay(state);
    case 'createFailed':
      return state.busy === 'creating' ? createFailed(state, event.error) : stay(state);
    case 'photoSaved':
      return state.photoSave === 'saving' ? stay({ ...state, photoSave: 'saved' }) : stay(state);
    case 'photoSaveFailed':
      return state.photoSave === 'saving' ? stay({ ...state, photoSave: 'failed' }) : stay(state);

    default:
      return state.busy === null ? personEvent(state, event) : stay(state);
  }
}
