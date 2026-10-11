/**
 * A named list of rows that open something (PropAjustes:140-161 and
 * 196-206): a bordered card, one row per item, each a button with an
 * optional outline icon, its label, an optional second line or value, and a
 * chevron. The rows come from an array, so a later unit adds one without
 * touching the screen (plan-cambios-11oct §8: "Que me encuentren por
 * @nombre", "Enlaces de invitación").
 */
import { ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx, FOCUS_RING_INSET, iconSize } from '../../ui';

export interface SettingsRowItem {
  id: string;
  label: ReactNode;
  /** A second line under the label. */
  body?: ReactNode;
  /** The current value at the right, such as "Ninguno". */
  value?: ReactNode;
  icon?: LucideIcon;
  onSelect(): void;
}

export interface SettingsRowsProps {
  /** The list's accessible name, such as "Cómo te encuentran". */
  label: string;
  items: readonly SettingsRowItem[];
}

export function SettingsRows({ label, items }: SettingsRowsProps) {
  return (
    <ul
      role="list"
      aria-label={label}
      className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0"
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <li key={item.id} className={cx(index > 0 && 'border-t border-ui-line')}>
            <button
              type="button"
              onClick={item.onSelect}
              className={cx(
                'flex w-full items-center gap-3 px-3.5 text-left font-ui text-ui-ink transition-colors hover:bg-ui-raised reduce-motion:transition-none',
                item.body ? 'min-h-[3.75rem] py-2.5' : 'min-h-[3.25rem] py-2',
                FOCUS_RING_INSET,
              )}
            >
              {Icon ? (
                <span className="flex shrink-0 text-ui-muted">
                  <Icon {...iconSize('lg')} aria-hidden="true" />
                </span>
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cx('text-ui-base', item.body ? 'font-semibold' : 'font-normal')}>{item.label}</span>
                {item.body ? <span className="text-ui-md text-ui-muted">{item.body}</span> : null}
              </span>
              {item.value !== undefined ? <span className="shrink-0 text-ui-md text-ui-muted">{item.value}</span> : null}
              <ChevronRight {...iconSize('md', 'shrink-0 text-ui-muted')} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
