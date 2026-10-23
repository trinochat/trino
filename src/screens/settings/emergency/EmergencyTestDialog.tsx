/**
 * "Probar mi clave de emergencia" (CE-5, design §8.4; PropClaveEmergencia
 * card 4): only inside the open account, never on the unlock screen.
 *
 * - **It writes nothing and counts nothing** (RC-16): `test_emergency_key`
 *   reads the session's vault and answers whether it matches.
 * - **The idle lock waits while it is open** (RC-17): a lock in the middle
 *   would leave the person typing the key on the unlock screen. A lock of
 *   the system cannot be held, so the dialog warns about it.
 * - **The field is unlike the unlock screen's** (RC-17): another name, no
 *   password manager, a dashed border, a monospaced font and no "show"
 *   toggle. What was typed goes when the dialog closes.
 */
import { Check } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useAutoLockHold } from '../../../app/autolock-hold';
import { useT } from '../../../lib/i18n';
import { Button, cx, Dialog, FOCUS_RING, iconSize } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import type { SettingsApi } from '../types';

export interface EmergencyTestDialogProps {
  api: Pick<SettingsApi, 'testEmergencyKey'>;
  onClose(): void;
}

type Result = 'yes' | 'no' | 'failed' | null;

export function EmergencyTestDialog({ api, onClose }: EmergencyTestDialogProps) {
  const t = useT();
  const fieldId = useId();
  const [candidate, setCandidate] = useState('');
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  useAutoLockHold();

  const test = async (event: FormEvent) => {
    event.preventDefault();
    if (candidate === '' || busy) return;
    setBusy(true);
    setResult(null);
    try {
      setResult((await api.testEmergencyKey(candidate)) ? 'yes' : 'no');
    } catch {
      setResult('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('emergency.test.title')} size="sm">
      <p className="m-0 -mt-2 text-ui-base leading-normal text-ui-ink">{t('emergency.test.body')}</p>
      <p className="m-0 rounded-ui bg-ui-raised px-3 py-2.5 text-ui-md leading-normal text-ui-ink">{t('emergency.test.lockNote')}</p>
      <form onSubmit={event => void test(event)} className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="font-ui text-ui-md font-semibold text-ui-ink">
          {t('emergency.test.field')}
        </label>
        <div className="flex gap-2">
          <input
            id={fieldId}
            name="emergency-trial"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={candidate}
            onChange={event => {
              setCandidate(event.target.value);
              setResult(null);
            }}
            className={cx(
              'min-h-11 min-w-0 flex-1 rounded-ui border border-dashed border-ui-control-line bg-ui-raised px-3 font-ui-mono text-ui-base text-ui-ink [color-scheme:var(--t-color-scheme)]',
              FOCUS_RING,
            )}
          />
          <Button type="submit" loading={busy}>
            {t('emergency.test.run')}
          </Button>
        </div>
      </form>
      <p role="status" className="m-0 flex items-start gap-2 text-ui-base font-semibold text-ui-ink">
        {result === 'yes' ? (
          <>
            <Check {...iconSize('md', 'mt-0.5 shrink-0 text-ui-ok')} aria-hidden="true" />
            <span>{t('emergency.test.yes')}</span>
          </>
        ) : result === 'no' ? (
          t('emergency.test.no')
        ) : null}
      </p>
      {result === 'failed' ? <ErrorLine>{t('emergency.err.test')}</ErrorLine> : null}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onClose}>
          {t('common2.close')}
        </Button>
      </div>
    </Dialog>
  );
}
