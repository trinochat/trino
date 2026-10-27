/**
 * Reportar (uso responsable UR-5, PropReportar; `Uso responsable/diseno.md`
 * §6.2, §8.3 and §12.4; U2 and U24; David's decision of 26 Oct).
 *
 * Three steps: what happened (nothing chosen at first), what you send, and
 * the exact list of what goes before it does.
 * - Spam starts with only their key; harassment, impersonation, fraud and
 *   anything else with the messages you mark (the one you touched marked,
 *   up to 11, theirs and yours, never another member's); a photo is only a
 *   line: that it exists, its rough size and its day.
 * - A child at risk and intimate images first show what to do, global
 *   since 15 Oct (no country's numbers or institutions), with INHOPE or
 *   StopNCII.org in the browser, and then send only their key and your
 *   description.
 * - The confirmation lists what goes and what does not, says that Trino
 *   deletes a report within 30 days at most (26 Oct), and offers the
 *   answer here and blocking them.
 * - Once made it waits sealed for Tor and can be cancelled; once the watcher
 *   sends it, the honest text of §6.5. A build that cannot seal one offers
 *   the e-mail and "Copiar datos del reporte": only the code, the kind, the
 *   fingerprint, the name they gave themselves, the day and your
 *   description (U24), never a message or a photo. That block lives only
 *   while the dialog is open (R-06).
 *
 * From the block's confirmation ("Reportar también", `mustBlock`), they are
 * blocked whether the report goes or not.
 */
import { CircleAlert, Copy, Flag } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BlockTarget,
  BlockedView,
  ReportCategory,
  ReportDraft,
  ReportMode,
  ReportPreview,
  SentReport,
  SentReportView,
} from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Button, Checkbox, Dialog, RadioCardGroup, Textarea, iconSize } from '../../ui';
import { ERROR_LINE } from '../contacts/styles';
import { fileKindOf, sizeText } from '../requests/requests-model';
import {
  MAX_PICKS,
  REPORT_CATEGORIES,
  confirmLines,
  defaultMode,
  reportData,
  takesNoContent,
  type ReportCandidate,
} from './report-model';

export interface ReportDialogApi {
  reportPreview(target: BlockTarget): Promise<ReportPreview>;
  sendReport(target: BlockTarget, draft: ReportDraft, block: boolean): Promise<SentReport>;
  cancelReport(id: string): Promise<void>;
  listSentReports(): Promise<SentReportView[]>;
  blockIdentity(target: BlockTarget): Promise<BlockedView>;
  /** `reports-changed`: a report went, or its answer came. */
  onReportsChanged?(cb: () => void): Promise<() => void>;
}

export interface ReportDialogProps {
  target: BlockTarget;
  /** How the dialog names them. */
  name: string;
  /** What may go of the chat (`candidatesOf`). */
  candidates: readonly ReportCandidate[];
  /** The message you touched: marked from the start. */
  initial?: string;
  /** "Reportar también" from the block's confirmation: they are blocked, sent or not. */
  mustBlock?: boolean;
  api: ReportDialogApi;
  /** Opens an address in the browser, with the usual notice that it does not go by Tor. */
  openLink(url: string): void;
  copyText(text: string): Promise<void>;
  onClose(): void;
  /** They were blocked from here. */
  onBlocked?(): void;
}

/** INHOPE, the international network of hotlines (David, 15 Oct). */
export const INHOPE_URL = 'https://www.inhope.org';
/** StopNCII.org, for intimate images of adults (David, 15 Oct). */
export const STOPNCII_URL = 'https://stopncii.org';
/** Your description, at most (design §6.2). */
const NOTE_MAX = 500;

type Step = 'what' | 'child' | 'ncii' | 'send' | 'confirm' | 'result';
type Outcome = 'queued' | 'sent' | 'cancelled' | 'unavailable';

const MUTED = 'm-0 text-ui-md leading-normal text-ui-muted';
const BODY = 'm-0 text-ui-base leading-normal text-ui-ink';

export function ReportDialog({
  target,
  name,
  candidates,
  initial,
  mustBlock = false,
  api,
  openLink,
  copyText,
  onClose,
  onBlocked,
}: ReportDialogProps) {
  const t = useT();
  const { lang } = useLang();
  const [step, setStep] = useState<Step>('what');
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [mode, setMode] = useState<ReportMode>('key_only');
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set(initial ? [initial] : []));
  const [note, setNote] = useState('');
  const [wantReply, setWantReply] = useState(false);
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<SentReport | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let live = true;
    apiRef.current.reportPreview(target).then(
      shown => live && setPreview(shown),
      () => live && setFailed('report.failed'),
    );
    return () => {
      live = false;
    };
  }, [target]);

  // While it waits, the watcher may send it: then the honest text of §6.5.
  const waitingId = outcome === 'queued' ? sent?.id : undefined;
  useEffect(() => {
    const listen = apiRef.current.onReportsChanged;
    if (!waitingId || !listen) return;
    let live = true;
    let stop: (() => void) | undefined;
    const check = () =>
      apiRef.current.listSentReports().then(
        list => {
          if (live && list.some(view => view.id === waitingId && view.state === 'sent')) setOutcome('sent');
        },
        () => {},
      );
    void listen(() => void check()).then(unlisten => {
      if (live) stop = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [waitingId]);

  const noContent = category !== null && takesNoContent(category);
  const withMessages = !noContent && mode === 'messages';
  const chosen = withMessages ? candidates.filter(candidate => marked.has(candidate.key)) : [];
  const kind = category ? t(`report.cat.${category}`) : '';
  const stepLine = (n: number) => (n === 1 ? t('report.step', { n }) : t('report.stepWith', { n, kind }));

  const leave = () => {
    if (busy) return;
    if (mustBlock && !sent) {
      setBusy(true);
      api.blockIdentity(target).then(
        () => {
          onBlocked?.();
          onClose();
        },
        () => {
          setBusy(false);
          setFailed('block.failed');
        },
      );
      return;
    }
    onClose();
  };

  const toSend = () => {
    if (!category) return;
    setMode(defaultMode(category));
    setStep(category === 'child' ? 'child' : category === 'ncii' ? 'ncii' : 'send');
  };

  const toggle = (key: string) =>
    setMarked(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < MAX_PICKS) next.add(key);
      return next;
    });

  const send = () => {
    if (!category || busy) return;
    setBusy(true);
    setFailed(null);
    const draft: ReportDraft = {
      category,
      mode: noContent ? 'description_only' : mode,
      picks: chosen.map(candidate => candidate.pick),
      note: note.trim(),
      want_reply: wantReply,
    };
    api.sendReport(target, draft, mustBlock || alsoBlock).then(
      made => {
        setBusy(false);
        setSent(made);
        setOutcome(made.queued ? 'queued' : 'unavailable');
        setStep('result');
        if (made.blocked) onBlocked?.();
      },
      () => {
        setBusy(false);
        setFailed('report.failed');
      },
    );
  };

  const cancelSent = () => {
    if (!sent || busy) return;
    setBusy(true);
    api.cancelReport(sent.id).then(
      () => {
        setBusy(false);
        setOutcome('cancelled');
      },
      () => {
        setBusy(false);
        setFailed('report.cancelFailed');
      },
    );
  };

  const copy = () => {
    if (!sent || !category || !preview) return;
    const text = reportData(t, lang, {
      id: sent.id,
      day: sent.day,
      category,
      fingerprint: preview.fingerprint,
      selfName: preview.self_handle,
      note: note.trim(),
    });
    copyText(text).then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    );
  };

  const footer = (...buttons: ReactNode[]) => <div className="flex flex-wrap justify-end gap-2">{buttons}</div>;
  const cancelButton = (
    <Button key="cancel" onClick={leave} disabled={busy}>
      {t('common2.cancel')}
    </Button>
  );
  const backButton = (to: Step) => (
    <Button key="back" onClick={() => setStep(to)} disabled={busy}>
      {t('report.back')}
    </Button>
  );
  const nextButton = (onClick: () => void, disabled = false) => (
    <Button key="next" variant="primary" onClick={onClick} disabled={disabled || busy}>
      {t('report.next')}
    </Button>
  );
  const describe = (
    <Textarea
      aria-label={t('report.describe')}
      placeholder={t('report.describe')}
      value={note}
      maxLength={NOTE_MAX}
      minRows={3}
      onChange={event => setNote(event.target.value.slice(0, NOTE_MAX))}
    />
  );

  let body: ReactNode;
  if (step === 'what') {
    body = (
      <>
        <p className={MUTED}>{stepLine(1)}</p>
        <RadioCardGroup
          aria-label={t('report.whatHappened')}
          options={REPORT_CATEGORIES.map(value => ({
            value,
            label: value === 'child' ? <strong>{t(`report.cat.${value}`)}</strong> : t(`report.cat.${value}`),
          }))}
          value={category}
          onValueChange={setCategory}
        />
        {footer(cancelButton, nextButton(toSend, category === null))}
      </>
    );
  } else if (step === 'child' || step === 'ncii') {
    const child = step === 'child';
    body = (
      <>
        {child ? (
          <>
            <p className={`${BODY} font-bold`}>{t('report.childEmergency')}</p>
            <p className={BODY}>{t('report.childDontShare')}</p>
            <p className={BODY}>{t('report.childAuthority')}</p>
          </>
        ) : (
          <>
            <p className={`${BODY} font-bold`}>{t('report.nciiDontShare')}</p>
            <p className={BODY}>{t('report.nciiAuthority')}</p>
          </>
        )}
        <p className={MUTED}>{t('report.tellTrino')}</p>
        {footer(
          backButton('what'),
          <Button key="link" onClick={() => openLink(child ? INHOPE_URL : STOPNCII_URL)}>
            {t(child ? 'report.inhope' : 'report.stopncii')}
          </Button>,
          <Button key="notify" variant="primary" leadingIcon={<Flag {...iconSize('md')} aria-hidden="true" />} onClick={() => setStep('send')}>
            {t('report.notify')}
          </Button>,
        )}
      </>
    );
  } else if (step === 'send') {
    body = (
      <>
        <p className={MUTED}>{stepLine(2)}</p>
        {noContent ? (
          <p className={BODY}>{t('report.noContentNote')}</p>
        ) : (
          <>
            <RadioCardGroup
              aria-label={t('report.whatGoes')}
                  options={[
                { value: 'key_only' as const, label: t('report.keyOnly') },
                { value: 'messages' as const, label: t('report.withMessages') },
              ]}
              value={mode === 'messages' ? 'messages' : 'key_only'}
              onValueChange={setMode}
            />
            {mode === 'key_only' ? <p className={BODY}>{t('report.keyOnlyNote')}</p> : null}
            {withMessages ? (
              <>
                <p className={BODY}>{t('report.pickNote')}</p>
                {candidates.length === 0 ? (
                  <p className={MUTED}>{t('report.noMessages')}</p>
                ) : (
                  <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {candidates.map(candidate => (
                      <Checkbox
                        key={candidate.key}
                        label={`${candidate.mine ? t('report.you') : name}: ${candidateText(candidate, t, lang)}`}
                        checked={marked.has(candidate.key)}
                        disabled={!marked.has(candidate.key) && marked.size >= MAX_PICKS}
                        onChange={() => toggle(candidate.key)}
                      />
                    ))}
                  </div>
                )}
                <p className={MUTED}>{t('report.pickLimit', { n: MAX_PICKS })}</p>
                <p className={MUTED}>{t('report.mediaNote')}</p>
              </>
            ) : null}
          </>
        )}
        {describe}
        {footer(backButton(noContent ? (category === 'child' ? 'child' : 'ncii') : 'what'), nextButton(() => setStep('confirm')))}
      </>
    );
  } else if (step === 'confirm') {
    const lines =
      category && preview
        ? confirmLines(t, {
            name,
            fingerprint: preview.fingerprint,
            selfName: preview.self_handle,
            category,
            mode: noContent ? 'description_only' : mode,
            chosen,
            note,
          })
        : null;
    body = (
      <>
        <p className={MUTED}>{stepLine(3)}</p>
        {lines ? (
          <>
            <p className={`${BODY} font-semibold`}>{t('report.sendsTitle')}</p>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ui-base text-ui-ink">
              {lines.sends.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className={MUTED}>{lines.notSent}</p>
            <p className={MUTED}>{t('report.retention')}</p>
            <div className="flex flex-col gap-1">
              <Checkbox label={t('report.wantReply')} checked={wantReply} onChange={event => setWantReply(event.target.checked)} />
              <Checkbox
                label={t('report.alsoBlock', { name })}
                checked={mustBlock || alsoBlock}
                disabled={mustBlock}
                onChange={event => setAlsoBlock(event.target.checked)}
              />
            </div>
          </>
        ) : null}
        {footer(
          cancelButton,
          <Button key="send" variant="primary" loading={busy} disabled={!lines} onClick={send}>
            {t('report.send')}
          </Button>,
        )}
      </>
    );
  } else {
    const code = sent ? <p className={`${BODY} font-semibold`}>{t('report.code', { id: sent.id })}</p> : null;
    const done = (
      <Button key="done" variant="primary" onClick={onClose}>
        {t('report.done')}
      </Button>
    );
    if (outcome === 'sent' && sent) {
      body = (
        <>
          <p className={`${BODY} font-semibold`}>{t('report.sentTitle', { id: sent.id })}</p>
          <p className={BODY}>{t('report.sentBody')}</p>
          <p className={MUTED}>{t('report.alone')}</p>
          <p className={MUTED}>{t('report.retention')}</p>
          {footer(done)}
        </>
      );
    } else if (outcome === 'cancelled') {
      body = (
        <>
          <p role="status" className={BODY}>
            {t('report.cancelled')}
          </p>
          {footer(done)}
        </>
      );
    } else if (outcome === 'unavailable') {
      body = (
        <>
          <p className={BODY}>{t('report.unavailable')}</p>
          {code}
          <Button className="self-start" leadingIcon={<Copy {...iconSize('md')} aria-hidden="true" />} onClick={copy}>
            {t('report.copy')}
          </Button>
          {copied ? (
            <p role="status" className={MUTED}>
              {copied === 'ok' && sent ? t('report.copied', { id: sent.id }) : t('report.copyFailed')}
            </p>
          ) : null}
          {footer(done)}
        </>
      );
    } else {
      body = (
        <>
          <p className={BODY}>{t('report.queued')}</p>
          {code}
          <p className={MUTED}>{t('report.retention')}</p>
          {footer(
            <Button key="cancelReport" onClick={cancelSent} loading={busy}>
              {t('report.cancel')}
            </Button>,
            done,
          )}
        </>
      );
    }
  }

  return (
    <Dialog open onClose={step === 'result' ? onClose : leave} title={t('report.title', { name })} closeOnEscape={!busy} size="md">
      <div className="flex flex-col gap-4">
        {body}
        {failed ? (
          <p role="alert" className={ERROR_LINE}>
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{t(failed)}</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** A message as text; a file as "Foto, unos 1,1 MB". */
function candidateText(candidate: ReportCandidate, t: ReturnType<typeof useT>, lang: ReturnType<typeof useLang>['lang']) {
  if (!candidate.file) return candidate.text ?? '';
  const size = sizeText(candidate.file.size, lang);
  const kind = fileKindOf(candidate.file.mime);
  return t(kind === 'photo' ? 'report.photoRow' : kind === 'video' ? 'report.videoRow' : 'report.fileRow', { size });
}
