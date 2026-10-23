/**
 * "Configurar o cambiar" (CE-5, design §8.2; PropClaveEmergencia card 3):
 * the same four steps whether a key is set or not, so nothing tells.
 *
 * 1. What it does not do (§11.2), and the box "Entiendo que no se puede
 *    deshacer", without which "Seguir" does nothing.
 * 2. Your password and, with two-step verification on, the code.
 * 3. The key twice. The two must match here; the rest of the rules (§8.3)
 *    live in Rust and come back as codes. The field is not offered to a
 *    password manager that would type it by itself (RC-14). A wrong password
 *    or code takes the person back to step 2 with its error.
 * 4. Done: "Probar sin borrar" and what makes it protect better. Only what
 *    this build has is suggested: Protección reforzada exists on Windows
 *    only, and the recovery kit (REC-06) not yet.
 *
 * What was typed lives in this component's state only, and goes with it.
 */
import { ArrowLeft, Shield, Wifi } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useT } from '../../../lib/i18n';
import { StrengthMeter } from '../../auth/onboarding/steps/PasswordStep';
import { passphraseStrength } from '../../auth/onboarding/passphrase-strength';
import { Button, Checkbox, Field, iconSize, IconButton, PasswordInput } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { SettingsRows, type SettingsRowItem } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi, SettingsPlatform } from '../types';
import { CredentialFields } from './CredentialFields';
import { cleanCode, credentialsProblem, KEY_MIN, keyProblem, type Problem } from './problems';

export interface EmergencySetupProps {
  api: Pick<SettingsApi, 'setEmergencyKey'>;
  totpEnabled: boolean;
  platform: SettingsPlatform;
  /** Back to the page of the emergency key. */
  onClose(): void;
  /** "Probar sin borrar". */
  onTest(): void;
  onOpenNetwork(): void;
  /** Settings › Privacidad, where Protección reforzada is. */
  onOpenReinforced?(): void;
}

type Step = 'before' | 'pass' | 'key' | 'done';

const STEPS: readonly Step[] = ['before', 'pass', 'key', 'done'];

/** What it does not do, in the order of the mockup (card 3), the first one in bold. */
const LIMITS = [
  'emergency.setup.onlyUnlock',
  'emergency.setup.notTheirs',
  'emergency.setup.copies',
  'emergency.setup.otherDevices',
  'emergency.setup.forensic',
  'emergency.setup.installed',
  'emergency.setup.kit',
  'emergency.setup.memorize',
] as const;

export function EmergencySetup({ api, totpEnabled, platform, onClose, onTest, onOpenNetwork, onOpenReinforced }: EmergencySetupProps) {
  const t = useT();
  const [step, setStep] = useState<Step>('before');
  const [understood, setUnderstood] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: Step) => {
    setProblem(null);
    setStep(next);
  };

  const toKey = (event: FormEvent) => {
    event.preventDefault();
    if (passphrase !== '') go('key');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (key !== repeat) {
      setProblem({ key: 'emergency.err.mismatch' });
      return;
    }
    setBusy(true);
    try {
      await api.setEmergencyKey(passphrase, key, totpEnabled ? cleanCode(code) : null);
      setPassphrase('');
      setCode('');
      setKey('');
      setRepeat('');
      go('done');
    } catch (cause) {
      const credentials = credentialsProblem(cause, totpEnabled);
      if (credentials) {
        setStep('pass');
        setProblem(credentials);
      } else {
        setProblem(keyProblem(cause, 'emergency.err.save'));
      }
    } finally {
      setBusy(false);
    }
  };

  const better: SettingsRowItem[] = [
    ...(platform === 'windows' && onOpenReinforced
      ? [
          {
            id: 'reinforced',
            icon: Shield,
            label: t('emergency.setup.reinforced'),
            body: t('emergency.setup.reinforcedBody'),
            onSelect: onOpenReinforced,
          },
        ]
      : []),
    { id: 'network', icon: Wifi, label: t('emergency.page.network'), body: t('emergency.setup.networkBody'), onSelect: onOpenNetwork },
  ];

  const strength = passphraseStrength(key);
  const error = problem ? <ErrorLine>{t(problem.key, problem.vars)}</ErrorLine> : null;

  return (
    <SettingsSection
      autoFocus
      title={t('emergency.setup.title')}
      before={<IconButton aria-label={t('emergency.setup.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onClose} />}
    >
      <p className="m-0 -mt-3 text-ui-md text-ui-muted">{t('emergency.setup.step', { n: STEPS.indexOf(step) + 1 })}</p>

      {step === 'before' ? (
        <>
          <ul
            role="list"
            aria-label={t('emergency.setup.limits')}
            className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0 text-ui-md leading-normal text-ui-ink"
          >
            <li className="px-3 py-2">
              <strong>{t('emergency.setup.undoTitle')}</strong> {t('emergency.setup.undo')}
            </li>
            {LIMITS.map(line => (
              <li key={line} className="border-t border-ui-line px-3 py-2">
                {t(line)}
              </li>
            ))}
          </ul>
          <Checkbox label={t('emergency.setup.understood')} checked={understood} onChange={event => setUnderstood(event.target.checked)} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose}>{t('common2.cancel')}</Button>
            <Button
              variant="primary"
              aria-disabled={!understood}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => understood && go('pass')}
            >
              {t('emergency.setup.continue')}
            </Button>
          </div>
        </>
      ) : null}

      {step === 'pass' ? (
        <form onSubmit={toKey} className="flex flex-col gap-4">
          <p className="m-0 text-ui-base text-ui-ink">{t('emergency.setup.passFirst')}</p>
          <p className="m-0 -mt-2 text-ui-md text-ui-muted">{t('emergency.setup.replaces')}</p>
          <CredentialFields
            passphrase={passphrase}
            code={code}
            totpEnabled={totpEnabled}
            onPassphrase={setPassphrase}
            onCode={setCode}
          />
          {error}
          <div className="flex justify-end">
            <Button type="submit" variant="primary">
              {t('emergency.setup.continue')}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'key' ? (
        <form onSubmit={event => void save(event)} className="flex flex-col gap-4">
          <Field
            label={t('emergency.setup.key')}
            hint={
              <span className="flex flex-col gap-1">
                {strength ? <StrengthMeter strength={strength} label={t(`onb.strength.${strength}`)} /> : null}
                <span>{t('emergency.setup.keyRule', { min: KEY_MIN })}</span>
              </span>
            }
          >
            <PasswordInput autoComplete="off" toggleLabel={t('emergency.setup.showKey')} value={key} onChange={event => setKey(event.target.value)} />
          </Field>
          <Field label={t('emergency.setup.repeat')}>
            <PasswordInput
              autoComplete="off"
              toggleLabel={t('emergency.setup.showKey')}
              value={repeat}
              onChange={event => setRepeat(event.target.value)}
            />
          </Field>
          {error}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy}>
              {t('emergency.setup.save')}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'done' ? (
        <>
          <div className="flex flex-col gap-1">
            <p role="status" className="m-0 text-ui-base font-semibold text-ui-ink">
              {t('emergency.setup.saved')}
            </p>
            <p className="m-0 text-ui-md text-ui-muted">{t('emergency.setup.tryNow')}</p>
          </div>
          <Button variant="primary" fullWidth onClick={onTest}>
            {t('emergency.setup.tryButton')}
          </Button>
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-ui-md font-semibold text-ui-muted">{t('emergency.setup.better')}</h3>
            <SettingsRows label={t('emergency.setup.better')} items={better} />
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('emergency.setup.done')}</Button>
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}
