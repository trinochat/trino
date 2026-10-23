/**
 * Your password and, with two-step verification on, a code of your app:
 * what configuring, removing and the network section of the emergency key
 * ask before anything (design §8.2, §8.5).
 */
import type { Ref } from 'react';
import { useT } from '../../../lib/i18n';
import { Field, Input, PasswordInput } from '../../../ui';

export interface CredentialFieldsProps {
  passphrase: string;
  code: string;
  totpEnabled: boolean;
  onPassphrase(value: string): void;
  onCode(value: string): void;
  passphraseRef?: Ref<HTMLInputElement>;
}

export function CredentialFields({ passphrase, code, totpEnabled, onPassphrase, onCode, passphraseRef }: CredentialFieldsProps) {
  const t = useT();
  return (
    <>
      <Field label={t('emergency.setup.passphrase')}>
        <PasswordInput
          ref={passphraseRef}
          autoComplete="current-password"
          toggleLabel={t('emergency.setup.showPassphrase')}
          value={passphrase}
          onChange={event => onPassphrase(event.target.value)}
        />
      </Field>
      {totpEnabled ? (
        <Field label={t('emergency.setup.code')}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            mono
            maxLength={7}
            value={code}
            onChange={event => onCode(event.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}
