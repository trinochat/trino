/**
 * "¿Quitar la clave de emergencia?" (CE-5, design §8.5; PropClaveEmergencia
 * card 5): your password (and the code, with two-step verification on),
 * then the same "Listo" whether there was a key or not.
 *
 * The mockup's second line, that a trusted contact would be told, waits for
 * CE-6: today no contact can be chosen, so it would promise nothing true.
 */
import { Trash2 } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useT } from '../../../lib/i18n';
import { Button, Dialog, iconSize } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import type { SettingsApi } from '../types';
import { CredentialFields } from './CredentialFields';
import { cleanCode, credentialsProblem, type Problem } from './problems';

export interface EmergencyRemoveDialogProps {
  api: Pick<SettingsApi, 'removeEmergencyKey'>;
  totpEnabled: boolean;
  onClose(): void;
}

export function EmergencyRemoveDialog({ api, totpEnabled, onClose }: EmergencyRemoveDialogProps) {
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const doneId = useId();
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const remove = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      await api.removeEmergencyKey(passphrase, totpEnabled ? cleanCode(code) : null);
      setPassphrase('');
      setCode('');
      setDone(true);
    } catch (cause) {
      setProblem(credentialsProblem(cause, totpEnabled) ?? { key: 'emergency.err.save' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      size="sm"
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusRef={field}
      // Done, the answer names the dialog, as in the mockup: no question over it.
      title={done ? undefined : t('emergency.remove.title')}
      labelledBy={done ? doneId : undefined}
      description={done ? undefined : t('emergency.remove.body')}
    >
      {done ? (
        <>
          <p id={doneId} role="status" className="m-0 text-ui-base leading-normal text-ui-ink">
            {t('emergency.remove.done')}
          </p>
          <div className="flex justify-end">
            {/* The password field went away with its focus. */}
            <Button variant="primary" autoFocus onClick={onClose}>
              {t('emergency.remove.ok')}
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={event => void remove(event)} className="flex flex-col gap-4">
          <CredentialFields
            passphrase={passphrase}
            code={code}
            totpEnabled={totpEnabled}
            onPassphrase={setPassphrase}
            onCode={setCode}
            passphraseRef={field}
          />
          {problem ? <ErrorLine>{t(problem.key, problem.vars)}</ErrorLine> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              {t('common2.cancel')}
            </Button>
            <Button type="submit" variant="dangerSolid" leadingIcon={<Trash2 {...iconSize('md')} />} loading={busy}>
              {t('emergency.remove.confirm')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
