/**
 * The warning to a trusted contact, in the chat with whoever set it
 * (clave de emergencia CE-6, design §7.2 and §11.6; PropClaveEmergencia
 * cards 9 and 10).
 *
 * - The question (CE-D4): a dialog over the chat, "Contacto de confianza",
 *   with what accepting means for you, and two buttons that look the same,
 *   so neither is pushed. It is no message: nothing of it lands in the
 *   chat's log, on either side.
 * - The warning that came: a fixed strip under the header, no red and no
 *   sound of its own, with when it was sent and when it arrived (CE-D15:
 *   it can come days after), the message if there is one, and "Qué puedes
 *   hacer", which says a warning can also be false (RC-09).
 */
import { useState } from 'react';
import { dayMonth, clockTime } from '../../lib/dates';
import { useLang } from '../../lib/i18n-context';
import { useT } from '../../lib/i18n';
import { Button, cx, Dialog, FOCUS_RING } from '../../ui';

export interface EmergencyAskDialogProps {
  /** The contact's name. */
  name: string;
  onAnswer(accept: boolean): Promise<void>;
  /** The answer went: `accept` says which. */
  onAnswered(accept: boolean): void;
}

export function EmergencyAskDialog({ name, onAnswer, onAnswered }: EmergencyAskDialogProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Closed without an answer, the question waits for the next time.
  const [closed, setClosed] = useState(false);
  if (closed) return null;

  const answer = async (accept: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      await onAnswer(accept);
      onAnswered(accept);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="sm"
      title={t('emergency.contact.title')}
      description={t('emergency.contact.ask', { name })}
      onClose={() => {
        if (!busy) setClosed(true);
      }}
    >
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('emergency.contact.askNote', { name })}</p>
      {failed ? (
        <p role="alert" className="m-0 text-ui-md font-semibold text-ui-danger">
          {t('emergency.contact.answerFailed')}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} onClick={() => void answer(false)}>
          {t('emergency.contact.decline')}
        </Button>
        <Button disabled={busy} onClick={() => void answer(true)}>
          {t('emergency.contact.accept')}
        </Button>
      </div>
    </Dialog>
  );
}

export interface EmergencyWarningStripProps {
  /** The contact's name. */
  name: string;
  /** When the warning arrived, in epoch seconds. */
  at: number;
  /**
   * When it was sent, in epoch seconds, by the sender's clock (never after
   * `at`); null for a warning kept before Trino kept that.
   */
  sent: number | null;
  message: string;
}

/** Whether `a` and `b`, in epoch seconds, fall on the same local day. */
function sameDay(a: number, b: number): boolean {
  return new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
}

export function EmergencyWarningStrip({ name, at, sent, message }: EmergencyWarningStripProps) {
  const t = useT();
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const came = { name, date: dayMonth(at, lang), time: clockTime(at, lang) };
  const when =
    sent === null
      ? t('emergency.contact.warning', came)
      : t(sameDay(sent, at) ? 'emergency.contact.warningSentSameDay' : 'emergency.contact.warningSent', {
          ...came,
          sentDate: dayMonth(sent, lang),
          sentTime: clockTime(sent, lang),
        });
  return (
    <div role="note" className="flex flex-col gap-1.5 border-b border-ui-line bg-ui-raised px-3.5 py-2.5 text-ui-md leading-[1.45] text-ui-ink">
      <p className="m-0">{when}</p>
      {message ? <p className="m-0 whitespace-pre-line text-ui-muted">{t('emergency.contact.quote', { message })}</p> : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className={cx('min-h-8 self-start rounded-ui border-0 bg-transparent p-0 font-semibold text-ui-accent-text underline', FOCUS_RING)}
      >
        {t('emergency.contact.whatToDo')}
      </button>
      {open ? <p className="m-0">{t('emergency.contact.whatToDoBody', { name })}</p> : null}
    </div>
  );
}
