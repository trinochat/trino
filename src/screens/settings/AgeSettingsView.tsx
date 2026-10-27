/**
 * Ajustes › Privacidad › Edad (uso responsable UR-10, PropMenoresPC cards 5
 * and 6; U16, U17, U23). Not a switch:
 * - "18 o más" → "16 o 17" at once, since it only closes: the confirmation
 *   says what goes (the requests that did not come by your links) and that
 *   contacts and chats stay. (The @name and the public card go too once
 *   they exist, with the invitations.)
 * - "16 o 17" → "18 o más" in 7 days, cancellable here, with "Cancelar" as
 *   the main button and the warning against whoever asks for it; at once in
 *   the account's first 24 hours, for whoever tapped wrong.
 * - With the phone's signal (the mobile engine), nothing to change here.
 * "Menos de 16" is not offered: nobody deletes an account by mistake or on
 * purpose from here (David, 25 Oct). The answer never leaves this device.
 */
import { ArrowLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AgeView } from '../../lib/api';
import { dayMonth } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Button, Dialog, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { SettingsSection } from './SettingsSection';

export interface AgeSettingsViewProps {
  age: AgeView;
  api: { setAge(bracket: 'minor' | 'adult'): Promise<AgeView>; cancelAgeChange(): Promise<AgeView> };
  /** The age changed: Privacidad shows it. */
  onChanged(age: AgeView): void;
  onBack(): void;
  autoFocus?: boolean;
}

type Asking = 'toMinor' | 'toAdult' | null;
type Note = 'age.toMinorDone' | 'age.toAdultDone' | 'age.cancelled' | null;

const LIST = 'm-0 flex list-disc flex-col gap-1 pl-5 text-ui-base text-ui-ink';

export function AgeSettingsView({ age, api, onChanged, onBack, autoFocus }: AgeSettingsViewProps) {
  const t = useT();
  const { lang } = useLang();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(age);
  const [asking, setAsking] = useState<Asking>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const run = async (action: () => Promise<AgeView>, done: (next: AgeView) => Note) => {
    setBusy(true);
    setFailed(false);
    setNote(null);
    try {
      const next = await action();
      setShown(next);
      setNote(done(next));
      onChanged(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };

  const minor = shown.bracket === 'minor';
  return (
    <SettingsSection
      autoFocus={autoFocus}
      title={t('age.row')}
      before={<IconButton aria-label={t('settings2.privacy.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {minor ? (
        <>
          <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('age.saidMinor')}</p>
          <ul className={LIST}>
            <li>{t('age.onlyAdded')}</li>
            <li>{t('age.noName')}</li>
            <li>{t('age.linksApproval')}</li>
          </ul>
        </>
      ) : (
        <>
          <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('age.saidAdult')}</p>
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('age.adultBody')}</p>
        </>
      )}
      {shown.from_store ? (
        <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('age.fromPhone')}</p>
      ) : shown.adult_from !== null ? (
        <>
          <p className="m-0 text-ui-base leading-normal text-ui-ink">
            {t('age.opensOn', { date: dayMonth(shown.adult_from, lang) })}
          </p>
          <Button
            className="self-start"
            loading={busy}
            onClick={() => void run(() => api.cancelAgeChange(), () => 'age.cancelled')}
          >
            {t('age.cancelChange')}
          </Button>
        </>
      ) : (
        <Button className="self-start" onClick={() => setAsking(minor ? 'toAdult' : 'toMinor')}>
          {t(minor ? 'age.toAdult' : 'age.toMinor')}
        </Button>
      )}
      {note ? (
        <p role="status" className="m-0 text-ui-md leading-normal text-ui-ink">
          {t(note)}
        </p>
      ) : null}
      {failed ? <ErrorLine>{t('age.failed')}</ErrorLine> : null}

      {asking === 'toMinor' ? (
        <Dialog
          open
          role="alertdialog"
          onClose={() => setAsking(null)}
          title={t('age.toMinorTitle')}
          initialFocusRef={cancelRef}
          closeOnEscape={!busy}
          size="sm"
        >
          <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('age.toMinorBody')}</p>
          <ul className={LIST}>
            <li>{t('age.toMinorRequests')}</li>
            <li>{t('age.toMinorLinks')}</li>
          </ul>
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('age.toMinorKeeps')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={cancelRef} onClick={() => setAsking(null)} disabled={busy}>
              {t('common2.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void run(() => api.setAge('minor'), () => 'age.toMinorDone')}
            >
              {t('age.change')}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {asking === 'toAdult' ? (
        <Dialog
          open
          role="alertdialog"
          onClose={() => setAsking(null)}
          title={t('age.toAdultTitle')}
          initialFocusRef={cancelRef}
          closeOnEscape={!busy}
          size="sm"
        >
          <p className="m-0 text-ui-base font-semibold leading-normal text-ui-ink">{t('age.toAdultWarning')}</p>
          <p className="m-0 text-ui-md leading-normal text-ui-muted">
            {t(shown.instant ? 'age.toAdultNow' : 'age.toAdultWait')}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={cancelRef} variant="primary" onClick={() => setAsking(null)} disabled={busy}>
              {t('common2.cancel')}
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                void run(
                  () => api.setAge('adult'),
                  next => (next.bracket === 'adult' ? 'age.toAdultDone' : null),
                )
              }
            >
              {t('age.toAdultConfirm')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}
