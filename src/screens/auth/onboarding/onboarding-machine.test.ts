import { describe, expect, it } from 'vitest';
import type { CommandError, CommandErrorCode, ForgeResponse, TotpBeginResponse } from '../../../lib/api';
import type { FirstWay } from '../../../lib/net';
import {
  hiddenOf,
  INITIAL_ONBOARDING,
  NAME_MAX,
  onboardingTransition,
  stepNumber,
  type OnboardingEffect,
  type OnboardingEvent,
  type OnboardingState,
} from './onboarding-machine';

const PASS = 'caballo-correcto-bateria';
const ENROLLMENT: TotpBeginResponse = { otpauth_uri: 'otpauth://totp/Trino:Rechita?secret=ABCD', secret_base32: 'ABCD' };
const CREATED: ForgeResponse = {
  handle: 'Rechita',
  fingerprint: 'f1f2',
  nostr_pub: 'b'.repeat(64),
  relay_connection_started: true,
  prefs_import: 'pending',
  custom_data_dir: false,
  bundle_json: '{"handle":"Rechita"}',
};
const PHOTO = 'data:image/jpeg;base64,AAAA';

const failure = (code: CommandErrorCode, extra: Partial<CommandError> = {}): CommandError => ({
  code,
  message: 'for the log',
  ...extra,
});

/** Applies the events in order, collecting every effect they ask for. */
function drive(from: OnboardingState, ...events: OnboardingEvent[]) {
  let state = from;
  const effects: OnboardingEffect[] = [];
  for (const event of events) {
    const next = onboardingTransition(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const consented = drive(INITIAL_ONBOARDING, { type: 'setPrivacy', checked: true }).state;
const atAge = drive(consented, { type: 'next' }).state;
const atName = drive(atAge, { type: 'setAge', answer: 'adult' }, { type: 'next' }).state;
const atPassword = drive(atName, { type: 'setName', value: '  Rechita ' }, { type: 'next' }).state;
const typed = drive(atPassword, { type: 'setPass', value: PASS }, { type: 'setPass2', value: PASS }).state;
const checking = drive(typed, { type: 'next' }).state;
const atStyle = drive(checking, { type: 'checked' }).state;
const atTwofa = drive(atStyle, { type: 'next' }).state;
const enrolling = drive(atTwofa, { type: 'activate' }).state;
const atSetup = drive(enrolling, { type: 'enrolled', enrollment: ENROLLMENT }).state;
const creatingWithoutTotp = drive(atTwofa, { type: 'later' }).state;

describe('the welcome step', () => {
  it('starts with the box unticked, no age and nothing in progress, as step 1 of 6', () => {
    expect(INITIAL_ONBOARDING).toMatchObject({
      step: 'welcome',
      age: null,
      privacyAccepted: false,
      busy: null,
      error: null,
    });
    expect(stepNumber(INITIAL_ONBOARDING)).toEqual({ current: 1, total: 6 });
  });

  // Ley 1581: without the data box there is no way on. The age is its own
  // step now (UR-10), no longer a box here.
  it('goes no further until the box of the data is ticked', () => {
    const consentError = { field: 'consent', key: 'onb.errConsent' };
    expect(drive(INITIAL_ONBOARDING, { type: 'next' }).state).toMatchObject({ step: 'welcome', error: consentError });
    expect(atAge).toMatchObject({ step: 'age', error: null });
  });

  it('keeps the consent error until the box is ticked', () => {
    const refused = drive(INITIAL_ONBOARDING, { type: 'next' }).state;
    expect(refused.error?.field).toBe('consent');
    expect(drive(refused, { type: 'setPrivacy', checked: true }).state.error).toBeNull();
  });

  // The flow moves the focus when the error changes: a second refusal is a
  // new error, so the focus goes to the box again.
  it('refuses with a new error each time', () => {
    const refused = drive(INITIAL_ONBOARDING, { type: 'next' }).state;
    const again = drive(refused, { type: 'next' }).state;
    expect(again.error).toEqual(refused.error);
    expect(again.error).not.toBe(refused.error);
  });
});

// UR-10 (PropMenoresPC cards 1 and 2; minimum of 16, David, 25 Oct): one
// question with three answers and none chosen, after the welcome and
// before the name.
describe('the age step', () => {
  it('is step 2 of 6, with nothing chosen, and goes no further until you answer', () => {
    expect(stepNumber(atAge)).toEqual({ current: 2, total: 6 });
    expect(atAge.age).toBeNull();
    expect(drive(atAge, { type: 'next' }).state).toMatchObject({ step: 'age', error: { field: 'age', key: 'onb.errAge' } });
  });

  // Under 16 no account is made; "Volver al inicio" goes to the welcome, not to the question.
  it('stops under 16, and goes back to the welcome without the answer', () => {
    const young = drive(atAge, { type: 'setAge', answer: 'under16' }, { type: 'next' });
    expect(young.state.step).toBe('tooYoung');
    expect(young.effects).toEqual([]);
    expect(stepNumber(young.state)).toBeNull();
    const restarted = drive(young.state, { type: 'restart' }).state;
    expect(restarted).toMatchObject({ step: 'welcome', age: null, error: null });
  });

  it('goes on with 16 or 17 and with 18 or more, and back to it from the name', () => {
    const minor = drive(atAge, { type: 'setAge', answer: 'minor' }, { type: 'next' }).state;
    expect(minor).toMatchObject({ step: 'name', age: 'minor' });
    expect(drive(atName, { type: 'back' }).state.step).toBe('age');
    expect(drive(atAge, { type: 'back' }).state.step).toBe('welcome');
  });

  // The answer goes with the new identity, and only there: never to a server.
  it('hands the answer to the identity it creates', () => {
    const minor = drive(atAge, { type: 'setAge', answer: 'minor' }, { type: 'next' }).state;
    const atPass = drive(minor, { type: 'setName', value: 'Mara' }, { type: 'next' }).state;
    const toTwofa = drive(
      atPass,
      { type: 'setPass', value: PASS },
      { type: 'setPass2', value: PASS },
      { type: 'next' },
      { type: 'checked' },
      { type: 'next' },
      { type: 'later' },
    );
    expect(toTwofa.effects).toContainEqual({ type: 'createIdentity', handle: 'Mara', passphrase: PASS, useTotp: false, age: 'minor' });
  });
});

describe('the name step', () => {
  const tryName = (value: string) => drive(atName, { type: 'setName', value }, { type: 'next' }).state;

  it('asks for a name', () => {
    for (const blank of ['', '   ']) {
      expect(tryName(blank)).toMatchObject({ step: 'name', error: { field: 'name', key: 'onb.errNameRequired' } });
    }
  });

  // Counted as Unicode scalars, as the backend counts them.
  it(`takes ${NAME_MAX} characters at most, an emoji being one`, () => {
    expect(NAME_MAX).toBe(40);
    expect(tryName('😀'.repeat(41))).toMatchObject({
      step: 'name',
      error: { field: 'name', key: 'onb.errNameTooLong', vars: { max: 40 } },
    });
    expect(tryName('😀'.repeat(40)).step).toBe('password');
    expect(tryName(`  ${'a'.repeat(40)}  `).step).toBe('password');
  });

  it('clears its error as the name changes', () => {
    const refused = tryName('');
    expect(drive(refused, { type: 'setName', value: 'R' }).state.error).toBeNull();
  });

  it('keeps the photo from makeAvatar, says when one failed, and removes it', () => {
    const withPhoto = drive(atName, { type: 'photoChosen', dataUrl: PHOTO }).state;
    expect(withPhoto.photo).toBe(PHOTO);
    const failed = drive(withPhoto, { type: 'photoFailed' }).state;
    expect(failed).toMatchObject({ photo: PHOTO, error: { field: 'photo', key: 'onb.errPhoto' } });
    expect(drive(failed, { type: 'photoChosen', dataUrl: PHOTO }).state.error).toBeNull();
    expect(drive(withPhoto, { type: 'removePhoto' }).state.photo).toBeNull();
  });
});

describe('going back', () => {
  it('goes one step back from each step, and from setting up 2FA to the question', () => {
    expect(drive(atName, { type: 'back' }).state.step).toBe('age');
    expect(drive(atPassword, { type: 'back' }).state.step).toBe('name');
    expect(drive(atStyle, { type: 'back' }).state.step).toBe('password');
    // A deviation from the board (plan §1.8, 8): the 2FA question goes back to the style.
    expect(drive(atTwofa, { type: 'back' }).state.step).toBe('style');
    expect(drive(atSetup, { type: 'back' }).state).toMatchObject({ step: 'twofa', twofa: 'ask' });
  });

  it('keeps what was typed, and has nowhere to go from the first step', () => {
    expect(drive(atPassword, { type: 'back' }).state.name).toBe('  Rechita ');
    expect(drive(INITIAL_ONBOARDING, { type: 'back' }).state).toBe(INITIAL_ONBOARDING);
  });
});

describe('the password step', () => {
  // The policy lives in Rust: the step asks it before going on (K1).
  it('asks the backend about the password before going on', () => {
    const { state, effects } = drive(typed, { type: 'next' });
    expect(state).toMatchObject({ step: 'password', busy: 'checking' });
    expect(effects).toEqual([{ type: 'checkPassphrase', passphrase: PASS }]);
  });

  it('ignores the person while it waits', () => {
    for (const event of [{ type: 'next' }, { type: 'back' }, { type: 'setPass', value: 'x' }] as const) {
      expect(drive(checking, event)).toEqual({ state: checking, effects: [] });
    }
  });

  it('goes on to the style once the policy agrees and both passwords match', () => {
    expect(atStyle).toMatchObject({ step: 'style', busy: null, error: null });
    const mismatched = drive(typed, { type: 'setPass2', value: `${PASS}!` }, { type: 'next' }, { type: 'checked' }).state;
    expect(mismatched).toMatchObject({ step: 'password', busy: null, error: { field: 'pass2', key: 'onb.errMismatch' } });
  });

  it('stays with the policy error, and the meter turns weak for a common password', () => {
    const short = drive(checking, { type: 'checkFailed', error: failure('passphrase_too_short', { min: 10 }) }).state;
    expect(short).toMatchObject({ step: 'password', busy: null, error: { field: 'pass', key: 'onb.errTooShort', vars: { min: 10 } } });
    const common = drive(checking, { type: 'checkFailed', error: failure('passphrase_too_common') }).state;
    expect(common).toMatchObject({ step: 'password', passRejected: true, error: { field: 'pass', key: 'onb.errTooCommon' } });
    expect(drive(common, { type: 'setPass', value: 'otra cosa' }).state).toMatchObject({ passRejected: false, error: null });
  });

  // A backend without check_passphrase rejects with a plain string; the
  // identity's creation checks the policy again, so the step goes on.
  it('goes on when the check itself fails for another reason', () => {
    expect(drive(checking, { type: 'checkFailed', error: 'command check_passphrase not found' }).state.step).toBe('style');
  });
});

describe('the 2FA question and its setup', () => {
  it('is step 6 of 6, after the style', () => {
    expect(atTwofa).toMatchObject({ step: 'twofa', twofa: 'ask' });
    expect(stepNumber(atTwofa)).toEqual({ current: 6, total: 6 });
    expect(stepNumber(atSetup)).toEqual({ current: 6, total: 6 });
  });

  // The enrollment is kept: going back and pressing Activar again shows the
  // same code, so what the person scanned stays valid (plan §3 W1).
  it('starts the enrollment once, with the name as its label, and keeps it', () => {
    const { state, effects } = drive(atTwofa, { type: 'activate' });
    expect(state.busy).toBe('enrolling');
    expect(effects).toEqual([{ type: 'totpBegin', label: 'Rechita' }]);
    expect(atSetup).toMatchObject({ twofa: 'setup', busy: null, enrollment: ENROLLMENT });
    const again = drive(atSetup, { type: 'back' }, { type: 'activate' });
    expect(again.state).toMatchObject({ twofa: 'setup', enrollment: ENROLLMENT });
    expect(again.effects).toEqual([]);
  });

  it('stays on the question when the enrollment fails', () => {
    const failed = drive(enrolling, { type: 'enrollFailed', error: failure('internal') }).state;
    expect(failed).toMatchObject({ twofa: 'ask', busy: null, error: { field: 'step', key: 'onb.errTotpBegin' } });
  });

  it('checks a code of 6 digits, spaces left out, and says when it is wrong', () => {
    const short = drive(atSetup, { type: 'setCode', value: '4829' }, { type: 'verify' });
    expect(short.state.error).toEqual({ field: 'code', key: 'onb.errCodeLength' });
    expect(short.effects).toEqual([]);
    const sent = drive(atSetup, { type: 'setCode', value: '482 913' }, { type: 'verify' });
    expect(sent.state.busy).toBe('verifying');
    expect(sent.effects).toEqual([{ type: 'totpVerify', code: '482913' }]);
    const wrong = drive(sent.state, { type: 'verified', ok: false }).state;
    expect(wrong).toMatchObject({ busy: null, error: { field: 'code', key: 'onb.errCode' } });
    const broken = drive(sent.state, { type: 'verifyFailed', error: failure('internal') }).state;
    expect(broken).toMatchObject({ busy: null, error: { field: 'code', key: 'onb.errTotpCheck' } });
  });

  it('creates the identity with 2FA once the code is right', () => {
    const sent = drive(atSetup, { type: 'setCode', value: '482913' }, { type: 'verify' }).state;
    const { state, effects } = drive(sent, { type: 'verified', ok: true });
    expect(state).toMatchObject({ busy: 'creating', totpVerified: true });
    expect(effects).toEqual([{ type: 'createIdentity', handle: 'Rechita', passphrase: PASS, useTotp: true, age: 'adult' }]);
  });

  it('creates the identity without 2FA on "Ahora no"', () => {
    const { state, effects } = drive(atTwofa, { type: 'later' });
    expect(state.busy).toBe('creating');
    expect(effects).toEqual([{ type: 'createIdentity', handle: 'Rechita', passphrase: PASS, useTotp: false, age: 'adult' }]);
  });
});

describe('creating the identity', () => {
  it('ends on "Todo listo", forgetting the passwords, the code and the TOTP secret', () => {
    const { state } = drive(creatingWithoutTotp, { type: 'created', response: CREATED });
    expect(state).toMatchObject({ step: 'done', created: CREATED, busy: null, pass: '', pass2: '', code: '', enrollment: null });
    expect(stepNumber(state)).toBeNull();
    const withTotp = drive(atSetup, { type: 'setCode', value: '482913' }, { type: 'verify' }, { type: 'verified', ok: true });
    expect(drive(withTotp.state, { type: 'created', response: CREATED }).state).toMatchObject({ code: '', enrollment: null });
  });

  // The record of the two boxes needs the new identity's public key.
  it('records the consent with the new public key, and saves the photo only when there is one', () => {
    expect(drive(creatingWithoutTotp, { type: 'created', response: CREATED }).effects).toEqual([
      { type: 'recordConsent', publicKey: CREATED.nostr_pub },
    ]);
    const withPhoto = drive(atName, { type: 'photoChosen', dataUrl: PHOTO }, { type: 'setName', value: 'Rechita' }, { type: 'next' });
    const ready = drive(
      withPhoto.state,
      { type: 'setPass', value: PASS },
      { type: 'setPass2', value: PASS },
      { type: 'next' },
      { type: 'checked' },
      { type: 'next' },
      { type: 'later' },
    ).state;
    const { state, effects } = drive(ready, { type: 'created', response: CREATED });
    expect(effects).toEqual([
      { type: 'recordConsent', publicKey: CREATED.nostr_pub },
      { type: 'saveProfile', handle: 'Rechita', avatar: PHOTO },
    ]);
    expect(state.photoSave).toBe('saving');
    expect(drive(state, { type: 'photoSaveFailed' }).state.photoSave).toBe('failed');
    expect(drive(state, { type: 'photoSaved' }).state.photoSave).toBe('saved');
  });

  it('sends a policy error back to the password step', () => {
    const short = drive(creatingWithoutTotp, { type: 'createFailed', error: failure('passphrase_too_short', { min: 10 }) }).state;
    expect(short).toMatchObject({ step: 'password', busy: null, error: { field: 'pass', key: 'onb.errTooShort', vars: { min: 10 } } });
    const common = drive(creatingWithoutTotp, { type: 'createFailed', error: failure('passphrase_too_common') }).state;
    expect(common).toMatchObject({ step: 'password', passRejected: true, error: { field: 'pass', key: 'onb.errTooCommon' } });
  });

  it('sends an unconfirmed TOTP secret back to checking a code', () => {
    const verified = drive(atSetup, { type: 'setCode', value: '482913' }, { type: 'verify' }, { type: 'verified', ok: true }).state;
    const back = drive(verified, { type: 'createFailed', error: failure('totp_not_verified') }).state;
    expect(back).toMatchObject({
      step: 'twofa',
      twofa: 'setup',
      totpVerified: false,
      code: '',
      error: { field: 'code', key: 'onb.errTotpNotVerified' },
    });
  });

  it('hands an identity that exists already to the parent', () => {
    const { state, effects } = drive(creatingWithoutTotp, { type: 'createFailed', error: failure('vault_exists') });
    expect(effects).toEqual([{ type: 'vaultExists' }]);
    expect(state.busy).toBeNull();
  });

  // io, internal or a plain text: try again where you are.
  it('lets the person try again right there after another failure', () => {
    for (const error of [failure('io'), failure('internal'), 'boom']) {
      const failed = drive(creatingWithoutTotp, { type: 'createFailed', error }).state;
      expect(failed).toMatchObject({ step: 'twofa', twofa: 'ask', busy: null, error: { field: 'step', key: 'onb.errCreate' } });
      expect(drive(failed, { type: 'later' }).effects).toEqual([
        { type: 'createIdentity', handle: 'Rechita', passphrase: PASS, useTotp: false, age: 'adult' },
      ]);
    }
  });

  // The backend keeps a confirmed secret, and the code may have expired by
  // now: trying again does not ask about the code again.
  it('tries again with 2FA without checking the code a second time', () => {
    const verified = drive(atSetup, { type: 'setCode', value: '482913' }, { type: 'verify' }, { type: 'verified', ok: true }).state;
    const failed = drive(verified, { type: 'createFailed', error: failure('io') }).state;
    expect(failed).toMatchObject({ twofa: 'setup', busy: null, error: { field: 'step', key: 'onb.errCreate' } });
    expect(drive(failed, { type: 'verify' }).effects).toEqual([
      { type: 'createIdentity', handle: 'Rechita', passphrase: PASS, useTotp: true, age: 'adult' },
    ]);
  });

  // Defence in depth: whatever happened before, no identity without the
  // box of the data, nor without an age of 16 or more.
  it('never creates an identity without the box, or without an age of 16 or more', () => {
    const cases = [
      [{ privacyAccepted: false }, 'welcome', { field: 'consent', key: 'onb.errConsent' }],
      [{ age: null }, 'age', { field: 'age', key: 'onb.errAge' }],
      [{ age: 'under16' as const }, 'age', { field: 'age', key: 'onb.errAge' }],
    ] as const;
    for (const [changed, step, error] of cases) {
      const later = drive({ ...atTwofa, ...changed }, { type: 'later' });
      expect(later.effects).toEqual([]);
      expect(later.state).toMatchObject({ step, busy: null, error });
      const sent = drive({ ...atSetup, ...changed }, { type: 'setCode', value: '482913' }, { type: 'verify' }).state;
      const verified = drive(sent, { type: 'verified', ok: true });
      expect(verified.effects).toEqual([]);
      expect(verified.state.step).toBe(step);
    }
  });
});

describe('answers that arrive late', () => {
  it('are ignored unless the flow waits for them', () => {
    const late: OnboardingEvent[] = [
      { type: 'checked' },
      { type: 'enrolled', enrollment: ENROLLMENT },
      { type: 'verified', ok: true },
      { type: 'created', response: CREATED },
      { type: 'createFailed', error: failure('vault_exists') },
      { type: 'photoSaveFailed' },
    ];
    for (const event of late) {
      expect(drive(atName, event), event.type).toEqual({ state: atName, effects: [] });
    }
  });
});

// TOR-6 (PropTorSimple, card 1; Tor design §9.2, design test 50): with the
// network, a "Conexión" step after the welcome. Tor starts only from it,
// with the provider option's bridge if chosen, and before any account.
// TOR-8 (card 4): "En mi red bloquean Tor" opens the other ways inside the
// step; the way chosen there is the one "Continuar" starts, and the
// provider option follows it.
describe('the connection step', () => {
  const withTor = { ...INITIAL_ONBOARDING, withConnection: true };
  const agreed = drive(withTor, { type: 'setPrivacy', checked: true }, { type: 'next' }, { type: 'setAge', answer: 'adult' }).state;
  const atConnection = drive(agreed, { type: 'next' }).state;
  const NONE: FirstWay = { kind: 'none' };
  const SNOWFLAKE: FirstWay = { kind: 'builtin', transport: 'snowflake' };
  const OBFS4: FirstWay = { kind: 'builtin', transport: 'obfs4' };

  it('comes after the age, as step 3 of 7, and starts nothing by itself', () => {
    const { state, effects } = drive(agreed, { type: 'next' });
    expect(state).toMatchObject({ step: 'connection', busy: null, error: null, way: NONE, bridges: false });
    expect(hiddenOf(state)).toBe(false);
    expect(stepNumber(state)).toEqual({ current: 3, total: 7 });
    expect(stepNumber(withTor)).toEqual({ current: 1, total: 7 });
    expect(effects).toEqual([]);
  });

  it('starts Tor on "Continuar", plainly or through the hidden way, then goes to the name', () => {
    const plain = drive(atConnection, { type: 'next' });
    expect(plain.state).toMatchObject({ step: 'connection', busy: 'connecting' });
    expect(plain.effects).toEqual([{ type: 'startConnection', way: NONE }]);
    expect(drive(plain.state, { type: 'connectionStarted' }).state).toMatchObject({ step: 'name', busy: null, started: NONE });

    const hidden = drive(atConnection, { type: 'setHidden', checked: true }, { type: 'next' });
    expect(hidden.effects).toEqual([{ type: 'startConnection', way: SNOWFLAKE }]);
    expect(drive(hidden.state, { type: 'connectionStarted' }).state).toMatchObject({ step: 'name', started: SNOWFLAKE });
  });

  it('says so when it could not start, and stays', () => {
    const busy = drive(atConnection, { type: 'next' }).state;
    expect(drive(busy, { type: 'connectionFailed' }).state).toMatchObject({
      step: 'connection',
      busy: null,
      error: { field: 'step', key: 'net.welcome.error' },
    });
  });

  it('goes back to it from the name, and starts again only for another choice', () => {
    const atNameAgain = drive(atConnection, { type: 'next' }, { type: 'connectionStarted' }).state;
    const back = drive(atNameAgain, { type: 'back' }).state;
    expect(back.step).toBe('connection');
    expect(drive(back, { type: 'back' }).state.step).toBe('age');

    const same = drive(back, { type: 'next' });
    expect(same.effects).toEqual([]);
    expect(same.state.step).toBe('name');

    const other = drive(back, { type: 'setHidden', checked: true }, { type: 'next' });
    expect(other.effects).toEqual([{ type: 'startConnection', way: SNOWFLAKE }]);
  });

  it('opens the other ways inside the step, and "Atrás" there goes back to the step', () => {
    const open = drive(atConnection, { type: 'openBridges' });
    expect(open.state).toMatchObject({ step: 'connection', bridges: true });
    expect(open.effects).toEqual([]);
    expect(drive(open.state, { type: 'back' }).state).toMatchObject({ step: 'connection', bridges: false });
    expect(drive(open.state, { type: 'closeBridges' }).state).toMatchObject({ step: 'connection', bridges: false });
  });

  it('starts the way chosen there, and the provider option follows it', () => {
    const chosen = drive(atConnection, { type: 'openBridges' }, { type: 'setWay', way: OBFS4 }).state;
    expect(chosen.way).toEqual(OBFS4);
    expect(hiddenOf(chosen)).toBe(true);
    // Ticking the option again keeps the way chosen; unticking it is no bridge.
    expect(drive(chosen, { type: 'setHidden', checked: true }).state.way).toEqual(OBFS4);
    expect(drive(chosen, { type: 'setHidden', checked: false }).state.way).toEqual(NONE);
    expect(drive(chosen, { type: 'setWay', way: NONE }).state).toMatchObject({ way: NONE });

    const go = drive(chosen, { type: 'next' });
    expect(go.state).toMatchObject({ bridges: false, busy: 'connecting' });
    expect(go.effects).toEqual([{ type: 'startConnection', way: OBFS4 }]);

    const code = drive(atConnection, { type: 'setWay', way: { kind: 'private' } }, { type: 'next' });
    expect(code.effects).toEqual([{ type: 'startConnection', way: { kind: 'private' } }]);
  });

  it('"Buscar una forma que funcione aquí" starts the search at once and goes on', () => {
    const search = drive(atConnection, { type: 'openBridges' }, { type: 'search' });
    expect(search.state).toMatchObject({ step: 'connection', bridges: false, busy: 'connecting', way: { kind: 'search' } });
    expect(search.effects).toEqual([{ type: 'startConnection', way: { kind: 'search' } }]);
    const started = drive(search.state, { type: 'connectionStarted' }).state;
    expect(started).toMatchObject({ step: 'name', started: { kind: 'search' } });
    expect(hiddenOf(started)).toBe(true);
    // Back and on again: the search runs already.
    expect(drive(started, { type: 'back' }, { type: 'next' }).effects).toEqual([]);
  });

  it('is not there without the network: the age leads to the name', () => {
    expect(stepNumber(consented)).toEqual({ current: 1, total: 6 });
    expect(drive(atAge, { type: 'setAge', answer: 'adult' }, { type: 'next' }).state.step).toBe('name');
    expect(drive(atName, { type: 'back' }).state.step).toBe('age');
  });
});
