/**
 * How the call travels, after its time: "03:21 · Conexión protegida" or
 * "03:21 · Conexión directa" (Call:88-103, L2b). Grey text with a dotted
 * underline, no pill; a click unfolds what it means, and Escape folds it
 * back. It comes from call.ts (`onConnectionMode`), never from guessing;
 * while the call rings it says nothing about the connection
 * (plan-cambios-11oct §6). Its parent lays it out in a wrapping row.
 */
import { useId, useState } from 'react';
import type { ConnectionMode } from '../../lib/call';
import { useT } from '../../lib/i18n';
import { FOCUS_RING, cx } from '../../ui';

export interface ConnectionModeLineProps {
  mode: ConnectionMode | null;
  /** The call is still ringing: nothing shows. */
  ringing?: boolean;
}

const LABEL = { protected: 'call2.mode.protected', direct: 'call2.mode.direct' } as const;
const HELP = { protected: 'call2.mode.protectedHelp', direct: 'call2.mode.directHelp' } as const;

export function ConnectionModeLine({ mode, ringing = false }: ConnectionModeLineProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const noteId = useId();
  if (!mode || ringing) return null;
  return (
    <>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? noteId : undefined}
        onClick={() => setOpen(o => !o)}
        onKeyDown={event => {
          if (event.key !== 'Escape' || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        className={cx(
          // A 44 px tall target around the line of text.
          "relative rounded-ui px-0.5 text-ui-md text-ui-muted underline decoration-dotted decoration-1 underline-offset-[3px] before:absolute before:inset-x-[-0.25rem] before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-['']",
          FOCUS_RING,
        )}
      >
        {t(LABEL[mode])}
      </button>
      {open && (
        <p
          id={noteId}
          role="note"
          className="m-0 max-w-[26.25rem] basis-full rounded-ui border border-ui-line bg-ui-surface px-3 py-2.5 text-ui-md leading-normal text-ui-ink"
        >
          {t(HELP[mode])}
        </p>
      )}
    </>
  );
}
