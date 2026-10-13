/**
 * The step between unlocking and the chats (cifrado local CL-2b, design
 * §6.2, §11.4 and §11.5), shown only when the unlock answer brings
 * something: first the one dialog about files of Trino that changed, then
 * the one note after the migration.
 *
 * The dialog lists what Trino found in short lines and takes no choice by
 * itself (design test 44): it opens on its heading, Escape and Enter do
 * nothing, and "Entendido" shows only once nothing waits. Everything that
 * waits is one question (design §6.1), whose two answers look alike and say
 * what each one risks (David's decision 3, design test 67). Files of an
 * earlier version are opened only when asked: "Ver qué traen", "Importarlos"
 * or "Borrarlos", which asks once more; leaving them as they are is also an
 * answer, and the next unlock offers them again. Below, always: "Si no fuiste
 * tú, alguien pudo tener acceso a este computador", with what to do.
 *
 * No help page exists yet, so "Qué hacer" opens two lines in place instead of
 * a link.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { isCommandError, type IntegrityReport, type LegacyPreview, type MigrationNote } from '../../../lib/api';
import { useT, type TFunction } from '../../../lib/i18n';
import { Button, FOCUS_RING, cx } from '../../../ui';
import { AuthFrame } from '../common/AuthFrame';
import { InlineError } from '../common/InlineError';
import { LABEL_TEXT } from '../common/styles';
import { storeCheckOf, type AskItem, type Question, type Review, type StoreCheck } from './store-check';

/** What the dialog needs from the backend: `api` of src/lib/api.ts. */
export interface StoreReviewApi {
  storeChoose(file: string, useIt: boolean): Promise<IntegrityReport>;
  legacyFilesPreview(): Promise<LegacyPreview>;
  legacyFilesImport(): Promise<IntegrityReport>;
  legacyFilesRemove(): Promise<IntegrityReport>;
}

export interface StoreReviewProps {
  review: Review;
  api: StoreReviewApi;
  /** Everything was answered and read: the chats. */
  onDone(): void;
}

const TITLE = 'm-0 rounded-ui font-ui-display text-[1.5rem] font-bold leading-[1.25]';
const TEXT = 'm-0 text-ui-base leading-normal';

/** A failure for the console: its code, never what the backend said in full. */
const codeOf = (error: unknown) => (isCommandError(error) ? error.code : 'not a command error');

export function StoreReview({ review, api, onDone }: StoreReviewProps) {
  const check = useMemo(() => storeCheckOf(review.integrity), [review.integrity]);
  const [step, setStep] = useState<'check' | 'note'>(check ? 'check' : 'note');
  const nothing = !check && !review.migration;
  useEffect(() => {
    if (nothing) onDone();
    // Once: an answer with nothing to show goes straight on.
  }, []);

  if (step === 'check' && check) {
    return (
      <IntegrityCheck
        key="check"
        check={check}
        api={api}
        onDone={() => (review.migration ? setStep('note') : onDone())}
      />
    );
  }
  if (review.migration) {
    return <MigrationNoteView key="note" note={review.migration} customDataDir={review.customDataDir} onDone={onDone} />;
  }
  return null;
}

/** The heading of a step, which takes the focus as the step opens. */
function StepTitle({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h1 id={id} ref={ref} tabIndex={-1} className={cx(TITLE, FOCUS_RING)}>
      {children}
    </h1>
  );
}

const SKIP_KEYS: Record<Question['kind'] | 'olderMany', { skip: string; use: string; without: string; ask: string }> = {
  older: { skip: 'integrity.skipOne', use: 'integrity.useOne', without: 'integrity.withoutOne', ask: 'integrity.askOlderOne' },
  olderMany: {
    skip: 'integrity.skipMany',
    use: 'integrity.useMany',
    without: 'integrity.withoutMany',
    ask: 'integrity.askOlderMany',
  },
  unverified: {
    skip: 'integrity.skipUnverified',
    use: 'integrity.useUnverified',
    without: 'integrity.withoutUnverified',
    ask: 'integrity.askUnverified',
  },
};

/** The words of the question: one older copy, several, or data nothing could check. */
function wordsOf(question: Question) {
  if (question.kind === 'unverified') return SKIP_KEYS.unverified;
  return question.files.length > 1 ? SKIP_KEYS.olderMany : SKIP_KEYS.older;
}

function IntegrityCheck({ check, api, onDone }: { check: StoreCheck; api: StoreReviewApi; onDone(): void }) {
  const t = useT();
  const titleId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);
  const [whatOpen, setWhatOpen] = useState(false);
  const whatId = useId();
  // Moves the focus to "Entendido" once an answer made it the next step.
  const [focusDone, setFocusDone] = useState(0);
  useEffect(() => {
    if (focusDone > 0) doneRef.current?.focus();
  }, [focusDone]);

  const [answered, setAnswered] = useState(check.question === null);
  const settled = () => setFocusDone(n => n + 1);

  return (
    <AuthFrame width="wide" labelledBy={titleId}>
      <div className="flex flex-col gap-2">
        <StepTitle id={titleId}>{t('integrity.title')}</StepTitle>
        <p className={cx(TEXT, 'text-ui-muted')}>{t('integrity.body')}</p>
      </div>

      {check.notices.length > 0 ? (
        <ul aria-label={t('integrity.listLabel')} className="m-0 flex list-none flex-col gap-2 p-0">
          {check.notices.map(notice => (
            <li key={`${notice.item}:${notice.kind}`} className={TEXT}>
              <strong className="font-semibold">{`${t(`integrity.item.${notice.item}`)}.`}</strong>{' '}
              <span>{t(`integrity.notice.${notice.kind}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {check.question ? (
        <QuestionPart
          question={check.question}
          api={api}
          onAnswered={() => {
            setAnswered(true);
            settled();
          }}
        />
      ) : null}

      {check.plainFiles ? (
        <PlainFilesPart
          api={api}
          onSettled={() => {
            if (answered) settled();
          }}
        />
      ) : null}

      <div className="flex flex-col gap-1 border-t border-ui-line pt-4">
        <p className={cx(TEXT, 'text-ui-muted')}>{t('integrity.footer')}</p>
        <button
          type="button"
          aria-expanded={whatOpen}
          aria-controls={whatId}
          onClick={() => setWhatOpen(open => !open)}
          className={cx(
            'min-h-11 self-start rounded-ui px-2 font-ui text-ui-base font-semibold text-ui-accent-text hover:underline',
            FOCUS_RING,
          )}
        >
          {t('integrity.whatToDo')}
        </button>
        <div id={whatId} hidden={!whatOpen} className="flex flex-col gap-2">
          <p className={TEXT}>{t('integrity.whatToDoLock')}</p>
          <p className={TEXT}>{t('integrity.whatToDoPass')}</p>
        </div>
      </div>

      {answered ? (
        <Button ref={doneRef} variant="primary" size="lg" fullWidth onClick={onDone}>
          {t('integrity.done')}
        </Button>
      ) : null}
    </AuthFrame>
  );
}

const ITEM_LABEL = (t: TFunction, item: AskItem) => t(`integrity.item.${item}`);

/** "Usar esa copia" or "Seguir sin ella", for every file that waits. */
function QuestionPart({ question, api, onAnswered }: { question: Question; api: StoreReviewApi; onAnswered(): void }) {
  const t = useT();
  const labelId = useId();
  const words = wordsOf(question);
  const without = t(words.without);
  const [pending, setPending] = useState<readonly string[]>(question.files);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [answer, setAnswer] = useState<'used' | 'skipped' | null>(null);
  const one = question.items.length === 1;
  const label = one ? ITEM_LABEL(t, question.items[0]!) : t('integrity.item.store');

  const choose = async (useIt: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    let left = pending;
    try {
      for (const file of pending) {
        await api.storeChoose(file, useIt);
        left = left.filter(other => other !== file);
      }
      setAnswer(useIt ? 'used' : 'skipped');
      onAnswered();
    } catch (error) {
      console.warn('store_choose failed:', codeOf(error));
      setFailed(true);
    } finally {
      setPending(left);
      setBusy(false);
    }
  };

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2 border-t border-ui-line pt-4">
      <p id={labelId} className={cx('m-0', LABEL_TEXT)}>
        {label}
      </p>
      <p className={TEXT}>{t(words.ask)}</p>
      {one ? (
        <>
          <p className={TEXT}>{t(`integrity.risk.${question.items[0]}`)}</p>
          <p className={TEXT}>{t(`integrity.loss.${question.items[0]}`, { without })}</p>
        </>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {question.items.map(item => (
            <li key={item} className={TEXT}>
              <strong className="font-semibold">{`${ITEM_LABEL(t, item)}.`}</strong>{' '}
              <span>{t(`integrity.risk.${item}`)}</span> <span>{t(`integrity.loss.${item}`, { without })}</span>
            </li>
          ))}
        </ul>
      )}
      {answer ? (
        <p role="status" className={cx(TEXT, 'font-semibold')}>
          {t(answer === 'used' ? 'integrity.used' : 'integrity.skipped')}
        </p>
      ) : (
        <>
          {/* The same style for both, so neither is pushed (David's decision 3). */}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void choose(false)}>
              {t(words.skip)}
            </Button>
            <Button disabled={busy} onClick={() => void choose(true)}>
              {t(words.use)}
            </Button>
          </div>
          {failed ? <InlineError>{t('integrity.errChoose')}</InlineError> : null}
        </>
      )}
    </div>
  );
}

type PlainAction = 'preview' | 'import' | 'remove';

/** "Ver qué traen", "Importarlos" or "Borrarlos" (design §4.8 and §11.4). */
function PlainFilesPart({ api, onSettled }: { api: StoreReviewApi; onSettled(): void }) {
  const t = useT();
  const labelId = useId();
  const [busy, setBusy] = useState<PlainAction | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<LegacyPreview | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [done, setDone] = useState<'imported' | 'removed' | null>(null);

  const run = async (action: PlainAction) => {
    if (busy) return;
    setBusy(action);
    setFailed(false);
    try {
      if (action === 'preview') {
        setPreview(await api.legacyFilesPreview());
      } else {
        await (action === 'import' ? api.legacyFilesImport() : api.legacyFilesRemove());
        setDone(action === 'import' ? 'imported' : 'removed');
        onSettled();
      }
    } catch (error) {
      console.warn(`legacy_files_${action} failed:`, codeOf(error));
      setFailed(true);
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  const names = (list: readonly string[]) => (list.length > 0 ? list.join(', ') : '—');

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2 border-t border-ui-line pt-4">
      <p id={labelId} className={cx('m-0', LABEL_TEXT)}>
        {t('integrity.plain.title')}
      </p>
      <p className={TEXT}>{t('integrity.plain.body')}</p>
      {preview && !done ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-ui-md leading-normal text-ui-muted [overflow-wrap:anywhere]">
          {preview.handle ? <li>{t('integrity.plain.name', { name: preview.handle })}</li> : null}
          <li>{t('integrity.plain.contacts', { n: preview.contacts.length, names: names(preview.contacts) })}</li>
          <li>{t('integrity.plain.groups', { n: preview.groups.length, names: names(preview.groups) })}</li>
          <li>
            {t('integrity.plain.counts', {
              chats: preview.conversations,
              blocked: preview.blocked,
              invites: preview.invitations,
              stickers: preview.stickers,
            })}
          </li>
          {preview.unreadable.length > 0 ? <li>{t('integrity.plain.unreadable', { files: preview.unreadable.join(', ') })}</li> : null}
        </ul>
      ) : null}
      {done ? (
        <p role="status" className={cx(TEXT, 'font-semibold')}>
          {t(done === 'imported' ? 'integrity.plain.imported' : 'integrity.plain.removed')}
        </p>
      ) : confirmRemove ? (
        <>
          <p className={cx(TEXT, 'font-semibold')}>{t('integrity.plain.removeAsk')}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => setConfirmRemove(false)}>
              {t('integrity.plain.removeNo')}
            </Button>
            <Button variant="danger" loading={busy === 'remove'} onClick={() => void run('remove')}>
              {t('integrity.plain.removeYes')}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button loading={busy === 'preview'} disabled={busy !== null && busy !== 'preview'} onClick={() => void run('preview')}>
            {t('integrity.plain.preview')}
          </Button>
          <Button loading={busy === 'import'} disabled={busy !== null && busy !== 'import'} onClick={() => void run('import')}>
            {t('integrity.plain.import')}
          </Button>
          <Button disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
            {t('integrity.plain.remove')}
          </Button>
        </div>
      )}
      {failed ? <InlineError>{t('integrity.plain.err')}</InlineError> : null}
    </div>
  );
}

/** The one note after the migration (design §11.5), with what it encrypted. */
function MigrationNoteView({ note, customDataDir, onDone }: { note: MigrationNote; customDataDir: boolean; onDone(): void }) {
  const t = useT();
  const titleId = useId();
  return (
    <AuthFrame width="narrow" labelledBy={titleId}>
      <StepTitle id={titleId}>{t('migrated.title')}</StepTitle>
      <div className="flex flex-col gap-3">
        <p className={TEXT}>
          {t('migrated.body', { contacts: note.contacts, groups: note.groups, notes: note.notes ?? 0, stickers: note.stickers })}
        </p>
        <p className={TEXT}>{t('migrated.leftovers')}</p>
        <p className={TEXT}>{t('migrated.copies')}</p>
        {customDataDir ? <p className={TEXT}>{t('migrated.otherFolders')}</p> : null}
      </div>
      <Button variant="primary" size="lg" fullWidth onClick={onDone}>
        {t('migrated.done')}
      </Button>
    </AuthFrame>
  );
}
