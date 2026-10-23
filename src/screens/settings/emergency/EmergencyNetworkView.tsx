/**
 * "Qué pasa en la red" (CE-5, design §8.1 and §8.5; PropClaveEmergencia
 * card 6): nothing of what was chosen shows until your password (and the
 * code, with two-step verification on) opens it, so whoever has the open
 * account does not learn whether a contact would be warned.
 *
 * Two options only (CE-D11: no asking the relays to delete): "Ninguna",
 * the default, and the warning to a trusted contact. The warning needs the
 * contact to accept it first from their Trino (`alert-reg`, `alert-ack`),
 * which is CE-6; until then it shows with its honest text, and cannot be
 * chosen. So there is nothing to save yet, and the view closes with
 * "Listo" instead of the mockup's "Guardar".
 *
 * CE-6 hooks in here: the backend answers `{ action: 'alert', … }` with
 * the contact's state (waiting, accepted, declined), and saving the choice
 * and the message of up to 280 characters goes through a new command.
 */
import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { EmergencyNetwork } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { Button, Checkbox, iconSize, IconButton } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi } from '../types';
import { CredentialFields } from './CredentialFields';
import { cleanCode, credentialsProblem, type Problem } from './problems';

export interface EmergencyNetworkViewProps {
  api: Pick<SettingsApi, 'emergencyNetwork'>;
  totpEnabled: boolean;
  onBack(): void;
}

export function EmergencyNetworkView({ api, totpEnabled, onBack }: EmergencyNetworkViewProps) {
  const t = useT();
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<EmergencyNetwork | null>(null);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      setChoice(await api.emergencyNetwork(passphrase, totpEnabled ? cleanCode(code) : null));
      setPassphrase('');
      setCode('');
    } catch (cause) {
      setProblem(credentialsProblem(cause, totpEnabled) ?? { key: 'emergency.err.open' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      autoFocus
      title={t('emergency.net.title')}
      before={<IconButton aria-label={t('emergency.setup.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {choice === null ? (
        <form onSubmit={event => void open(event)} className="flex flex-col gap-4">
          <p className="m-0 text-ui-base text-ui-ink">{t('emergency.net.locked')}</p>
          <CredentialFields
            passphrase={passphrase}
            code={code}
            totpEnabled={totpEnabled}
            onPassphrase={setPassphrase}
            onCode={setCode}
          />
          {problem ? <ErrorLine>{t(problem.key, problem.vars)}</ErrorLine> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy}>
              {t('emergency.setup.continue')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="m-0 -mt-2 text-ui-md leading-normal text-ui-muted">{t('emergency.net.intro')}</p>
          <div
            role="group"
            aria-label={t('emergency.net.title')}
            className="flex flex-col overflow-hidden rounded-ui-lg border border-ui-line"
          >
            <Checkbox
              className="px-3.5"
              label={t('emergency.net.none')}
              description={t('emergency.net.noneBody')}
              checked={choice.action === 'none'}
              // The only choice there is until CE-6: it stays on.
              onChange={() => {}}
            />
            <div className="border-t border-ui-line">
              <Checkbox
                className="px-3.5"
                label={t('emergency.net.alert')}
                description={t('emergency.net.alertBody')}
                checked={false}
                disabled
              />
              <p className="m-0 pb-3 pe-3.5 ps-[2.875rem] text-ui-md leading-normal text-ui-muted">{t('emergency.net.alertSoon')}</p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={onBack}>{t('emergency.setup.done')}</Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
