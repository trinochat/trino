/**
 * The SAS v2 of a call (Call:112-153, docs/sas-v2.md): the key at the top of
 * the call, and the comparison it opens with "Coinciden" and "No coinciden".
 *
 * - The key shows the 7 symbols, each icon with its word (20 px at 100 %,
 *   `size="lg"`), wrapping to two rows when they do not fit; its name reads
 *   the 7 words in order. A verified call shows "Llamada verificada".
 * - The comparison shows them bigger (28 px, `size="2xl"`). "Coinciden"
 *   closes it and gives the focus back to the key; "No coinciden" asks both
 *   people to update and call again (plan §6, mitigation 1). Escape closes
 *   it too, and keeps that key from the screen around it.
 * - New symbols start over, closed.
 *
 * `children` is what the stage shows while the comparison is closed, such as
 * the contact's avatar.
 */
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { SasSymbol } from '../../lib/SasSymbol';
import { sasWords } from '../../lib/sas-symbols';
import { Banner, Button, FOCUS_RING, cx, iconSize } from '../../ui';
import type { CallSas } from './useCallController';

export interface SasKeyProps {
  sas: CallSas;
  peerName: string;
  onMatch(): void;
  children?: ReactNode;
}

export function SasKey(props: SasKeyProps) {
  return <OneKey key={props.sas.indices.join('.')} {...props} />;
}

function OneKey({ sas, peerName, onMatch, children }: SasKeyProps) {
  const t = useT();
  const { lang } = useLang();
  const [open, setOpen] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const keyRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();
  const words = sasWords(sas.indices, lang).join(', ');
  const close = () => {
    setOpen(false);
    keyRef.current?.focus();
  };
  return (
    <div
      className="contents"
      onKeyDown={event => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        ref={keyRef}
        type="button"
        aria-label={t(sas.verified ? 'call2.sas.pillVerified' : 'call2.sas.pill', { words })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(o => !o)}
        className={cx(
          'relative z-10 mx-3 mt-3 inline-flex min-h-11 max-w-[calc(100%-1.5rem)] items-center gap-2 self-center rounded-3xl border border-ui-line bg-ui-surface py-1.5 pl-3 pr-2.5 text-ui-ink',
          FOCUS_RING,
        )}
      >
        {sas.verified ? (
          <span className="inline-flex items-center gap-1.5 text-ui-md font-semibold text-ui-accent-text safe-colors:text-ui-ok">
            <Check {...iconSize('md')} aria-hidden="true" />
            {t('call2.sas.verified')}
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-start justify-center gap-x-2 gap-y-1 text-ui-xs">
            {sas.indices.map((index, i) => (
              <SasSymbol key={i} index={index} size="lg" />
            ))}
          </span>
        )}
        <span className="flex shrink-0 text-ui-muted">
          {open ? <ChevronUp {...iconSize('sm')} aria-hidden="true" /> : <ChevronDown {...iconSize('sm')} aria-hidden="true" />}
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-labelledby={headingId}
          className="relative z-10 mx-auto mb-4 mt-2 flex w-[min(27.5rem,92%)] flex-col gap-3 rounded-ui-lg border border-ui-line bg-ui-surface p-4 [box-shadow:var(--t-shadow)]"
        >
          <h3 id={headingId} className="m-0 text-ui-base font-bold">
            {t('call2.sas.title', { name: peerName })}
          </h3>
          {mismatch ? (
            <Banner tone="danger">{t('call2.sas.mismatchAlert')}</Banner>
          ) : (
            <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('call2.sas.body', { name: peerName })}</p>
          )}
          <ul
            role="list"
            aria-label={t('call2.sas.list')}
            className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(3rem,1fr))] gap-x-1 gap-y-2 p-0"
          >
            {sas.indices.map((index, i) => (
              <li key={i} className="flex min-w-0 justify-center text-center text-ui-xs font-semibold">
                <SasSymbol index={index} size="2xl" />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className="flex-[1_1_8.75rem]"
              onClick={() => {
                onMatch();
                close();
              }}
            >
              {t('call2.sas.match')}
            </Button>
            <Button variant="danger" className="flex-[1_1_8.75rem]" onClick={() => setMismatch(true)}>
              {t('call2.sas.mismatch')}
            </Button>
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
