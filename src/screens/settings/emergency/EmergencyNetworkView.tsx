/**
 * "Qué pasa en la red" (CE-5 and CE-6, design §7.2, §8.1 and §8.5;
 * PropClaveEmergencia card 6): nothing of what was chosen shows until your
 * password (and the code, with two-step verification on) opens it, so
 * whoever has the open account does not learn whether a contact would be
 * warned.
 *
 * Two options (CE-D11: no asking the relays to delete), as boxes that
 * unmark each other: "Ninguna", the default, and the warning to a trusted
 * contact. With the warning: who (only the contacts whose Trino reads it,
 * said under the list), a note when the one picked is not verified, where
 * the saved contact's answer stands (waiting, accepted, declined), and the
 * optional message of up to 280 characters. "Guardar" sends it through
 * the backend, which asks the contact (CE-D4).
 *
 * The password opens the section for ten minutes, so the message can be
 * written without the code running out; after that, or after a lock,
 * "Guardar" brings the password back. What was typed lives in this
 * component's state only.
 */
import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { isCommandError, type EmergencyNetworkView as NetworkView } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { Button, Checkbox, Field, iconSize, IconButton, RadioCardGroup, Textarea } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi } from '../types';
import { CredentialFields } from './CredentialFields';
import { cleanCode, credentialsProblem, type Problem } from './problems';

/** The longest message (design §11.3). */
const MESSAGE_MAX = 280;

export interface EmergencyNetworkViewProps {
  api: Pick<SettingsApi, 'emergencyNetwork' | 'saveEmergencyNetwork' | 'listNodes'>;
  totpEnabled: boolean;
  /** Whether you verified the contact `handle` with its code `fingerprint` (`prefs.isVerified`). */
  isVerified(handle: string, fingerprint: string): boolean;
  onBack(): void;
}

/** What the boxes, the list and the message say now, before "Guardar". */
interface Draft {
  alert: boolean;
  contact: string | null;
  message: string;
}

function draftOf(view: NetworkView): Draft {
  return view.action === 'alert'
    ? { alert: true, contact: view.contact, message: view.message }
    : { alert: false, contact: null, message: '' };
}

export function EmergencyNetworkView({ api, totpEnabled, isVerified, onBack }: EmergencyNetworkViewProps) {
  const t = useT();
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<NetworkView | null>(null);
  const [draft, setDraft] = useState<Draft>({ alert: false, contact: null, message: '' });
  const [verified, setVerified] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState(false);

  const show = (next: NetworkView) => {
    setView(next);
    setDraft(draftOf(next));
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      show(await api.emergencyNetwork(passphrase, totpEnabled ? cleanCode(code) : null));
      setPassphrase('');
      setCode('');
      // Who is verified: a list that cannot be read verifies no one.
      const nodes = await api.listNodes().catch(() => []);
      setVerified(new Set(nodes.filter(node => isVerified(node.handle, node.fingerprint)).map(node => node.handle)));
    } catch (cause) {
      setProblem(credentialsProblem(cause, totpEnabled) ?? { key: 'emergency.err.open' });
    } finally {
      setBusy(false);
    }
  };

  const edit = (next: Partial<Draft>) => {
    setSaved(false);
    setProblem(null);
    setDraft(current => ({ ...current, ...next }));
  };

  const save = async () => {
    setProblem(null);
    setSaved(false);
    setBusy(true);
    try {
      const choice =
        draft.alert && draft.contact !== null
          ? { action: 'alert' as const, contact: draft.contact, message: draft.message }
          : { action: 'none' as const };
      show(await api.saveEmergencyNetwork(choice));
      setSaved(true);
    } catch (cause) {
      if (isCommandError(cause) && cause.code === 'wrong_passphrase') {
        // The section closed: the password again.
        setView(null);
        setProblem({ key: 'emergency.net.closed' });
      } else {
        setProblem({ key: 'emergency.net.saveFailed' });
      }
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (view === null) {
    body = (
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
    );
  } else {
    const candidates = view.candidates;
    // Where the saved contact's answer stands, while that is the one picked.
    const answer =
      view.action === 'alert' && draft.alert && draft.contact === view.contact
        ? t(`emergency.net.${view.state}`, { name: view.contact })
        : null;
    const unverified = draft.alert && draft.contact !== null && !verified.has(draft.contact);
    const canSave = !draft.alert || draft.contact !== null;
    body = (
      <>
        <p className="m-0 -mt-2 text-ui-md leading-normal text-ui-muted">{t('emergency.net.intro')}</p>
        <div role="group" aria-label={t('emergency.net.title')} className="flex flex-col overflow-hidden rounded-ui-lg border border-ui-line">
          <Checkbox
            className="px-3.5"
            label={t('emergency.net.none')}
            description={t('emergency.net.noneBody')}
            checked={!draft.alert}
            onChange={event => edit(event.target.checked ? { alert: false } : { alert: true })}
          />
          <div className="border-t border-ui-line">
            <Checkbox
              className="px-3.5"
              label={t('emergency.net.alert')}
              description={t('emergency.net.alertBody')}
              checked={draft.alert}
              onChange={event => edit({ alert: event.target.checked })}
            />
            {draft.alert ? (
              <div className="flex flex-col gap-3 pb-3.5 pe-3.5 ps-[2.875rem]">
                {candidates.length === 0 ? (
                  <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('emergency.net.noReaders')}</p>
                ) : (
                  <>
                    <RadioCardGroup
                      label={t('emergency.net.who')}
                      value={draft.contact !== null && candidates.includes(draft.contact) ? draft.contact : null}
                      onValueChange={contact => edit({ contact })}
                      options={candidates.map(handle => ({
                        value: handle,
                        label: handle,
                        description: t(verified.has(handle) ? 'emergency.net.verified' : 'emergency.net.unverified'),
                      }))}
                    />
                    <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('emergency.net.onlyReaders')}</p>
                  </>
                )}
                {unverified ? (
                  <p className="m-0 rounded-ui bg-ui-warn-bg px-3 py-2.5 text-ui-md leading-normal text-ui-ink">
                    {t('emergency.net.notVerified', { name: draft.contact ?? '' })}
                  </p>
                ) : null}
                {answer ? (
                  <p role="status" className="m-0 text-ui-md font-semibold leading-normal text-ui-ink">
                    {answer}
                  </p>
                ) : null}
                <Field label={t('emergency.net.message')} hint={t('emergency.net.messageHint')}>
                  <Textarea
                    maxLength={MESSAGE_MAX}
                    value={draft.message}
                    onChange={event => edit({ message: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </div>
        {problem ? <ErrorLine>{t(problem.key, problem.vars)}</ErrorLine> : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {saved ? (
            <p role="status" className="m-0 text-ui-md text-ui-muted">
              {t('emergency.net.saved')}
            </p>
          ) : null}
          <Button variant="primary" loading={busy} disabled={!canSave} onClick={() => void save()}>
            {t('emergency.net.save')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <SettingsSection
      autoFocus
      title={t('emergency.net.title')}
      before={<IconButton aria-label={t('emergency.setup.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {body}
    </SettingsSection>
  );
}
