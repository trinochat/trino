/**
 * What shows while the app reads the status, and when it cannot (plan §3
 * W1). It replaces the boot console: no fake log, no TRINO://, nothing that
 * blinks (principle 1). The status usually answers in a few ms, so nothing
 * shows for the first moment, which would only flash before the next screen.
 */
import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { Button, TrinoLogo, iconSize } from '../../../ui';

export interface StartupScreenProps {
  failed: boolean;
  onRetry(): void;
}

export interface StartupScreenOptions {
  /** How long to show nothing while loading, in ms. */
  delayMs?: number;
}

export function StartupScreen({ failed, onRetry, delayMs = 400 }: StartupScreenProps & StartupScreenOptions) {
  const t = useT();
  const [waited, setWaited] = useState(delayMs <= 0);
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (waited) return;
    const timer = setTimeout(() => setWaited(true), delayMs);
    return () => clearTimeout(timer);
  }, [waited, delayMs]);

  useEffect(() => {
    if (failed) retryRef.current?.focus();
  }, [failed]);

  const showMark = failed || waited;
  return (
    <div className="h-full overflow-y-auto bg-ui-bg [background-image:var(--t-scan)] font-ui text-ui-ink">
      <main className="flex min-h-full flex-col items-center justify-center gap-5 px-4 py-10 text-center">
        {showMark ? <TrinoLogo size={48} decorative className="size-12 text-ui-accent-text" /> : null}
        {failed ? (
          <>
            <p role="alert" className="m-0 flex max-w-[26rem] items-start gap-2 text-left text-ui-base">
              <CircleAlert aria-hidden="true" {...iconSize('lg', 'mt-0.5 shrink-0 text-ui-danger')} />
              <span>{t('start.error')}</span>
            </p>
            <Button ref={retryRef} variant="primary" onClick={onRetry}>
              {t('start.retry')}
            </Button>
          </>
        ) : (
          <p role="status" className="m-0 text-ui-base text-ui-muted">
            {waited ? t('start.loading') : ''}
          </p>
        )}
      </main>
    </div>
  );
}
