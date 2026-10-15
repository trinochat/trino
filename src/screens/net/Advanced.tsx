/**
 * "Opciones avanzadas" (PropTorSimple, cards 4, 6, 7 and 9): the technical
 * details, closed at first, under a button that says whether it is open.
 * One app, not two modes: the plain words show to everyone, these a tap
 * away.
 */
import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useT } from '../../lib/i18n';
import { cx, FOCUS_RING, iconSize } from '../../ui';

export function Advanced({ children }: { children: ReactNode }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={cx(
          'inline-flex min-h-11 items-center gap-1.5 self-start rounded-ui px-1 font-ui text-ui-md font-semibold text-ui-muted hover:text-ui-ink',
          FOCUS_RING,
        )}
      >
        {t('net.settings.advanced')}
        <ChevronDown {...iconSize('sm', cx('transition-transform reduce-motion:transition-none', open && 'rotate-180'))} aria-hidden="true" />
      </button>
      <div id={id} className="flex flex-col gap-2.5">
        {open ? children : null}
      </div>
    </div>
  );
}
