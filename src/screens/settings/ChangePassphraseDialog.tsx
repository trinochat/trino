/**
 * Changing your password (Settings:176-179, K6): the current one, the new
 * one twice and, with two-step verification on, a code of the app. The
 * policy lives in Rust (passphrase.rs), so its answers come back as
 * errors: too short, with the minimum, or too common.
 */
import { useState, type FormEvent } from 'react';
import { isCommandError } from '../../lib/api';
import { useT, type TVars } from '../../lib/i18n';
import { Button, Dialog, Field, Input, PasswordInput } from '../../ui';
import { ErrorLine } from './ErrorLine';
import type { SettingsApi } from './types';

export interface ChangePassphraseDialogProps {
  api: Pick<SettingsApi, 'changePassphrase'>;
  /** Two-step verification is on: the change takes a code too. */
  totpEnabled: boolean;
  onClose(): void;
  onDone(): void;
}

interface Problem {
  key: string;
  vars?: TVars;
}

/** The policy's minimum, as K1 and K6 report it; 10 since R3.3. */
const DEFAULT_MIN = 10;

function problemOf(cause: unknown): Problem {
  if (!isCommandError(cause)) return { key: 'settings2.passphrase.errGeneric' };
  switch (cause.code) {
    case 'passphrase_too_short':
      return { key: 'settings2.passphrase.errShort', vars: { min: cause.min ?? DEFAULT_MIN } };
    case 'passphrase_too_common':
      return { key: 'settings2.passphrase.errCommon' };
    case 'wrong_passphrase':
      return { key: 'settings2.passphrase.errWrong' };
    case 'invalid_totp':
    case 'totp_required':
      return { key: 'settings2.passphrase.errCode' };
    default:
      return { key: 'settings2.passphrase.errGeneric' };
  }
}

export function ChangePassphraseDialog({ api, totpEnabled, onClose, onDone }: ChangePassphraseDialogProps) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (next !== repeat) {
      setProblem({ key: 'settings2.passphrase.errMismatch' });
      return;
    }
    setBusy(true);
    try {
      await api.changePassphrase(current, next, totpEnabled ? code.replace(/\s/g, '') : null);
      onDone();
    } catch (cause) {
      setProblem(problemOf(cause));
      setBusy(false);
    }
  };

  const showLabel = t('settings2.security.showPassphrase');
  return (
    <Dialog open onClose={onClose} closeLabel={t('common2.close')} title={t('settings2.passphrase.title')}>
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        <Field label={t('settings2.passphrase.current')}>
          <PasswordInput
            autoComplete="current-password"
            toggleLabel={showLabel}
            value={current}
            onChange={event => setCurrent(event.target.value)}
          />
        </Field>
        <Field label={t('settings2.passphrase.next')} hint={t('settings2.passphrase.nextHint')}>
          <PasswordInput
            autoComplete="new-password"
            toggleLabel={showLabel}
            value={next}
            onChange={event => setNext(event.target.value)}
          />
        </Field>
        <Field label={t('settings2.passphrase.repeat')}>
          <PasswordInput
            autoComplete="new-password"
            toggleLabel={showLabel}
            value={repeat}
            onChange={event => setRepeat(event.target.value)}
          />
        </Field>
        {totpEnabled ? (
          <Field label={t('settings2.passphrase.code')}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              mono
              maxLength={7}
              value={code}
              onChange={event => setCode(event.target.value)}
            />
          </Field>
        ) : null}
        {problem ? <ErrorLine>{t(problem.key, problem.vars)}</ErrorLine> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common2.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t('settings2.security.changePassphrase')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
