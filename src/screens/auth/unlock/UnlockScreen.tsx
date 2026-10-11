/**
 * The unlock screen of the redesign (R3.6, Unlock:50-90): the avatar, a
 * greeting and why Trino is locked; the password, and the code of the
 * authenticator app only when the vault has 2FA (or asks for one); one error
 * at a time in an alert tied to its field; and "¿Olvidaste la contraseña?",
 * which explains what wiping loses and asks before doing it.
 *
 * The password never reaches the console: a failure is logged by its code.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isCommandError } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { identityInitials } from '../../../lib/initials';
import { Avatar, Banner, Button, FOCUS_RING, Field, Input, PasswordInput, cx } from '../../../ui';
import type { UnlockScreenProps } from '../../types';
import { AuthFrame } from '../common/AuthFrame';
import { ForgotPanel } from './ForgotPanel';
import { lockReasonText } from './lock-reason';
import { unlockFailure } from './unlock-errors';
import { WipeDialog } from './WipeDialog';

type FieldName = 'pass' | 'code';

/** The error under the fields, and the field it is about, if any. */
interface ShownError {
  key: string;
  field: FieldName | null;
}

/** The digits of a TOTP code as typed: "482 913" is 482913. */
const codeDigits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

export function UnlockScreen({ handle, totpEnabled, reason, api, onUnlocked, onNoVault, onWiped }: UnlockScreenProps) {
  const t = useT();
  const titleId = useId();
  const errorId = useId();
  const forgotId = useId();
  const [pass, setPass] = useState('');
  const [code, setCode] = useState('');
  /** The code field shows when the vault says it has 2FA, or once unlocking asked for a code. */
  const [askCode, setAskCode] = useState(totpEnabled === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  /** A field to focus once the screen shows what changed (a new error, the code field). */
  const [focusRequest, setFocusRequest] = useState<{ field: FieldName; n: number } | null>(null);

  useEffect(() => {
    mounted.current = true;
    passRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    const input = focusRequest.field === 'pass' ? passRef.current : codeRef.current;
    input?.focus();
    if (focusRequest.field === 'pass') input?.select();
  }, [focusRequest]);

  const show = (shown: ShownError) => {
    setError(shown);
    if (shown.field) {
      const field = shown.field;
      setFocusRequest(previous => ({ field, n: (previous?.n ?? 0) + 1 }));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    if (pass === '') return show({ key: 'unlock2.errEmpty', field: 'pass' });
    const digits = codeDigits(code);
    if (askCode && digits === '') return show({ key: 'unlock2.codeRequired', field: 'code' });

    busyRef.current = true;
    setBusy(true);
    setError(null);
    api.unseal(pass, askCode ? digits : null).then(
      response => {
        busyRef.current = false;
        if (!mounted.current) return;
        setPass('');
        setCode('');
        setBusy(false);
        onUnlocked(response);
      },
      (failure: unknown) => {
        busyRef.current = false;
        console.warn('unlock failed:', isCommandError(failure) ? failure.code : 'not a command error');
        if (!mounted.current) return;
        setBusy(false);
        const shown = unlockFailure(failure, askCode);
        if (shown.kind === 'noVault') return onNoVault();
        if (shown.kind === 'codeRequired') {
          setAskCode(true);
          return show({ key: 'unlock2.codeRequired', field: 'code' });
        }
        // A code is good for 30 seconds: after a failure, type the current one.
        if (shown.field === 'pass') setCode('');
        show({ key: shown.key, field: shown.field });
      },
    );
  };

  /** Typing in the field an error is about clears that error. */
  const edited = (field: FieldName) => {
    if (error?.field === field) setError(null);
  };

  const invalid = (field: FieldName) => (error?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {});

  return (
    <AuthFrame width="narrow" labelledBy={titleId}>
      <div className="flex flex-col items-center gap-3 text-center">
        <Avatar initials={identityInitials(handle ?? '')} size={64} />
        <h1 id={titleId} className="m-0 font-ui-display text-[1.5rem] font-bold leading-[1.25]">
          {handle ? t('unlock2.title', { name: handle }) : t('unlock2.titleNoName')}
        </h1>
        <p className="m-0 text-ui-base leading-normal text-ui-muted">{lockReasonText(reason, t)}</p>
      </div>

      <form noValidate onSubmit={submit} className="flex flex-col gap-[1.125rem]">
        <Field label={t('unlock2.passLabel')}>
          <PasswordInput
            ref={passRef}
            value={pass}
            autoComplete="current-password"
            toggleLabel={t('unlock2.showPassword')}
            onChange={event => {
              setPass(event.target.value);
              edited('pass');
            }}
            {...invalid('pass')}
          />
        </Field>
        {askCode ? (
          <Field label={t('unlock2.codeLabel')} hint={t('unlock2.codeHint')}>
            <Input
              ref={codeRef}
              mono
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="text-[1.25rem] tracking-[0.12em]"
              onChange={event => {
                setCode(event.target.value);
                edited('code');
              }}
              {...invalid('code')}
            />
          </Field>
        ) : null}
        {error ? (
          <Banner tone="danger">
            <span id={errorId}>{t(error.key)}</span>
          </Banner>
        ) : null}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
          {busy ? t('unlock2.unlocking') : t('unlock2.submit')}
        </Button>
      </form>

      <button
        type="button"
        aria-expanded={forgotOpen}
        aria-controls={forgotId}
        onClick={() => setForgotOpen(open => !open)}
        className={cx(
          'min-h-11 self-center rounded-ui px-2 font-ui text-ui-base font-semibold text-ui-accent-text hover:underline',
          FOCUS_RING,
        )}
      >
        {t('unlock2.forgot')}
      </button>
      {forgotOpen ? <ForgotPanel id={forgotId} onWipe={() => setWipeOpen(true)} /> : null}
      {wipeOpen ? <WipeDialog onClose={() => setWipeOpen(false)} wipe={() => api.wipe()} onWiped={onWiped} /> : null}
    </AuthFrame>
  );
}
