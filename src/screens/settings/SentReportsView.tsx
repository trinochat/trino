/**
 * "Reportes enviados" (uso responsable UR-5, PropReportar card 8; R-06;
 * David's decision of 26 Oct), opened from Settings > Privacidad: only
 * "Reporte", its code and its day, never its kind, whom or what, so whoever
 * uses this device does not learn whom you reported. Trino's answer shows
 * here and nowhere else, only if you asked for it. One that waits can be
 * cancelled; one that could not go says to write to abuso@ with its code.
 * Trino deletes a report within 30 days at most, and after 30 days the
 * report, its envelope and its token leave this device too: the backend
 * takes it out of the list.
 */
import { ArrowLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { SentReportView } from '../../lib/api';
import { dayMonth } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Button, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { SettingsSection } from './SettingsSection';

export interface SentReportsViewProps {
  /** The reports of the last 30 days, the latest first; null until read. */
  reports: readonly SentReportView[] | null;
  /** The last reading of the list failed. */
  loadFailed?: boolean;
  /** Reads the list again; resolves to whether it could be read. */
  onRetry?(): Promise<boolean>;
  /** Cancels one that waits. */
  onCancel(id: string): Promise<void>;
  onBack(): void;
  autoFocus?: boolean;
}

export function SentReportsView({ reports, loadFailed = false, onRetry, onCancel, onBack, autoFocus }: SentReportsViewProps) {
  const t = useT();
  const { lang } = useLang();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const title = t('report.sentList');

  const cancel = async (id: string) => {
    setBusy(id);
    setFailed(false);
    try {
      await onCancel(id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const list = (): ReactNode => {
    if (reports === null) {
      return loadFailed ? null : (
        <p role="status" className="m-0 text-ui-base text-ui-muted">
          {t('settings2.privacy.loading')}
        </p>
      );
    }
    if (reports.length === 0) return <p className="m-0 text-ui-base text-ui-muted">{t('report.empty')}</p>;
    return (
      <ul role="list" aria-label={title} className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0">
        {reports.map((view, index) => (
          <li
            key={view.id}
            className={
              index > 0
                ? 'flex min-h-14 flex-col gap-1 border-t border-ui-line px-3.5 py-2'
                : 'flex min-h-14 flex-col gap-1 px-3.5 py-2'
            }
          >
            <span className="font-ui text-ui-base font-semibold text-ui-ink">{t('report.row')}</span>
            <span className="text-ui-md text-ui-muted">
              {t('report.rowLine', { id: view.id, date: dayMonth(view.created_at, lang) })}
            </span>
            {view.state === 'waiting' ? <span className="text-ui-md text-ui-muted">{t('report.waiting')}</span> : null}
            {view.state === 'refused' ? <span className="text-ui-md text-ui-ink">{t('report.refused')}</span> : null}
            {view.write_instead ? (
              <span className="text-ui-md text-ui-ink">{t('report.writeInstead', { id: view.id })}</span>
            ) : null}
            {view.reply ? (
              <span className="text-ui-md text-ui-ink">{t('report.reply', { id: view.id, reply: view.reply })}</span>
            ) : null}
            {view.state === 'waiting' ? (
              <Button
                className="self-start"
                aria-label={t('report.cancelA11y', { id: view.id })}
                loading={busy === view.id}
                onClick={() => void cancel(view.id)}
              >
                {t('report.cancel')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <SettingsSection
      autoFocus={autoFocus}
      title={title}
      before={<IconButton aria-label={t('settings2.privacy.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('report.sentListBody')}</p>
      {failed ? <ErrorLine>{t('report.cancelFailed')}</ErrorLine> : null}
      {loadFailed ? (
        <>
          <ErrorLine>{t('report.loadFailed')}</ErrorLine>
          {onRetry ? (
            <Button className="self-start" onClick={() => void onRetry()}>
              {t('common2.retry')}
            </Button>
          ) : null}
        </>
      ) : null}
      {list()}
    </SettingsSection>
  );
}
