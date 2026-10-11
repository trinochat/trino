/**
 * Turning two-step verification on or off (Settings:180-183, K5).
 *
 * On: a new secret (`totpBegin`, named after you in the authenticator app)
 * as a QR code and as text, then a code from the app that `totpVerify`
 * accepts, and only then your password, so `totpEnable` seals a secret
 * your app really has. Off: your password and a valid code (T4).
 */
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState, type FormEvent } from 'react';
import { isCommandError, type TotpBeginResponse } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, cx, Dialog, Field, Input, PasswordInput, QR_FRAME } from '../../ui';
import { ErrorLine } from './ErrorLine';
import type { SettingsApi } from './types';

export interface TotpDialogProps {
  mode: 'enable' | 'disable';
  api: Pick<SettingsApi, 'totpBegin' | 'totpVerify' | 'totpEnable' | 'totpDisable'>;
  /** The name of the account in the authenticator app: yours. */
  label: string;
  onClose(): void;
  /** It changed: read the state again. */
  onDone(): void;
}

type Step = 'starting' | 'scan' | 'confirm';

/** The secret in groups of four, as people type it; the apps ignore the spaces. */
function groupSecret(secret: string): string {
  return (secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

function errorKey(cause: unknown): string {
  if (!isCommandError(cause)) return 'settings2.totp.errGeneric';
  if (cause.code === 'wrong_passphrase') return 'settings2.totp.errPassphrase';
  if (cause.code === 'invalid_totp' || cause.code === 'totp_required' || cause.code === 'totp_not_verified') {
    return 'settings2.totp.errCode';
  }
  return 'settings2.totp.errGeneric';
}

export function TotpDialog({ mode, api, label, onClose, onDone }: TotpDialogProps) {
  const t = useT();
  const [step, setStep] = useState<Step>(mode === 'enable' ? 'starting' : 'confirm');
  const [secret, setSecret] = useState<TotpBeginResponse | null>(null);
  const [code, setCode] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'enable') return;
    let live = true;
    api.totpBegin(label).then(
      begun => {
        if (!live) return;
        setSecret(begun);
        setStep('scan');
      },
      () => {
        if (live) setError('settings2.totp.errStart');
      },
    );
    return () => {
      live = false;
    };
    // One secret per opening.
  }, []);

  const digits = code.replace(/\s/g, '');
  const codeIsWhole = /^\d{6}$/.test(digits);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!codeIsWhole) {
      setError('settings2.totp.errCodeFormat');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (await api.totpVerify(digits)) setStep('confirm');
      else setError('settings2.totp.errCode');
    } catch (cause) {
      setError(errorKey(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'disable' && !codeIsWhole) {
      setError('settings2.totp.errCodeFormat');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (mode === 'enable') await api.totpEnable(passphrase);
      else await api.totpDisable(passphrase, digits);
      onDone();
    } catch (cause) {
      setError(errorKey(cause));
      setBusy(false);
    }
  };

  const codeField = (autoFocus: boolean) => (
    <Field label={t('settings2.totp.code')}>
      <Input
        autoFocus={autoFocus}
        inputMode="numeric"
        autoComplete="one-time-code"
        mono
        maxLength={7}
        value={code}
        onChange={event => setCode(event.target.value)}
      />
    </Field>
  );
  const passphraseField = (
    <Field label={t('settings2.totp.passphrase')}>
      <PasswordInput
        autoFocus
        autoComplete="current-password"
        toggleLabel={t('settings2.security.showPassphrase')}
        value={passphrase}
        onChange={event => setPassphrase(event.target.value)}
      />
    </Field>
  );
  const actions = (submit: string) => (
    <div className="flex flex-wrap justify-end gap-2">
      <Button onClick={onClose}>{t('common2.cancel')}</Button>
      <Button type="submit" variant="primary" loading={busy}>
        {submit}
      </Button>
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      closeLabel={t('common2.close')}
      title={t(mode === 'enable' ? 'settings2.totp.enableTitle' : 'settings2.totp.disableTitle')}
    >
      {step === 'starting' ? (
        error ? <ErrorLine>{t(error)}</ErrorLine> : <p className="m-0 text-ui-base text-ui-muted">{t('settings2.totp.starting')}</p>
      ) : null}

      {step === 'scan' && secret ? (
        <form onSubmit={event => void verify(event)} className="flex flex-col gap-4">
          <p className="m-0 text-ui-base">{t('settings2.totp.scan')}</p>
          <div role="img" aria-label={t('settings2.totp.qrA11y')} className={cx(QR_FRAME, 'w-[12.5rem] self-center')}>
            <QRCodeSVG value={secret.otpauth_uri} size={256} fgColor="currentColor" bgColor="transparent" className="h-full w-full" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-ui-md text-ui-muted">{t('settings2.totp.secret')}</p>
            <code className="font-ui-mono text-ui-base text-ui-ink [overflow-wrap:anywhere]">{groupSecret(secret.secret_base32)}</code>
          </div>
          {codeField(true)}
          {error ? <ErrorLine>{t(error)}</ErrorLine> : null}
          {actions(t('settings2.totp.verify'))}
        </form>
      ) : null}

      {step === 'confirm' ? (
        <form onSubmit={event => void finish(event)} className="flex flex-col gap-4">
          <p className="m-0 text-ui-base">
            {t(mode === 'enable' ? 'settings2.totp.confirmBody' : 'settings2.totp.disableBody')}
          </p>
          {passphraseField}
          {mode === 'disable' ? codeField(false) : null}
          {error ? <ErrorLine>{t(error)}</ErrorLine> : null}
          {actions(t(mode === 'enable' ? 'settings2.security.enable' : 'settings2.security.disable'))}
        </form>
      ) : null}
    </Dialog>
  );
}
