/**
 * Toasts: short messages at the bottom centre. Info and success are read out
 * politely and leave after a few seconds; errors are alerts that stay until
 * the person closes them, because errors that vanished on their own hid real
 * failures. Every text, the close button's name included, comes from the screen.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { iconSize } from '../../design/type';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  tone: ToastTone;
  text: string;
  /** Label of an optional action button, such as "Deshacer". */
  actionLabel?: string;
  /** Runs on the action button; the toast closes after it. */
  onAction?: () => void;
  /** Info and success only: how long the toast stays, in ms. Errors stay until closed. */
  durationMs?: number;
  /** Accessible name of this error's close button, instead of the provider's. */
  closeLabel?: string;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export interface ToastProviderProps {
  /** Accessible name of the close button of error toasts, such as "Cerrar". */
  closeLabel: string;
  /** How long info and success toasts stay, in ms. Default 5000. */
  durationMs?: number;
  /** How many toasts fit on screen, the newest. Default 3. */
  maxVisible?: number;
  children?: ReactNode;
}

interface ToastEntry extends ToastOptions {
  id: string;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ closeLabel, durationMs = 5000, maxVisible = 3, children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const lastId = useRef(0);

  const dismiss = useCallback((id: string) => setToasts(current => current.filter(toast => toast.id !== id)), []);
  const show = useCallback(
    (options: ToastOptions) => {
      const id = `toast-${++lastId.current}`;
      setToasts(current => {
        const next = [...current, { ...options, id }];
        // Info and success pushed off screen by newer toasts are dropped; errors
        // wait and come back when there is room, so no failure is lost.
        const firstVisible = next.length - maxVisible;
        return next.filter((toast, index) => index >= firstVisible || toast.tone === 'error');
      });
      return id;
    },
    [maxVisible],
  );
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  const visible = toasts.slice(-maxVisible);
  const card = (toast: ToastEntry) => (
    <ToastCard
      key={toast.id}
      toast={toast}
      durationMs={toast.tone === 'error' ? null : (toast.durationMs ?? durationMs)}
      closeLabel={toast.closeLabel ?? closeLabel}
      onDismiss={dismiss}
    />
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 font-ui">
          <div className="flex w-full flex-col items-center gap-2">
            {visible.filter(toast => toast.tone === 'error').map(card)}
          </div>
          {/* Always in the DOM, so screen readers watch it before the first toast arrives. */}
          <div aria-live="polite" className="flex w-full flex-col items-center gap-2">
            {visible.filter(toast => toast.tone !== 'error').map(card)}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast() needs a <ToastProvider> above it.');
  return api;
}

const TONES = {
  info: { Icon: Info, iconColour: 'text-ui-accent-text', background: 'bg-ui-surface' },
  success: { Icon: CircleCheck, iconColour: 'text-ui-ok', background: 'bg-ui-surface' },
  error: { Icon: CircleAlert, iconColour: 'text-ui-danger', background: 'bg-ui-danger-bg' },
} as const;

interface ToastCardProps {
  toast: ToastEntry;
  /** Null: stays until closed. */
  durationMs: number | null;
  closeLabel: string;
  onDismiss: (id: string) => void;
}

function ToastCard({ toast, durationMs, closeLabel, onDismiss }: ToastCardProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Paused while pointed at or focused, so its action can still be reached (WCAG 2.2.1).
  useCountdown(durationMs, hovered || focused, () => onDismiss(toast.id));
  const { Icon, iconColour, background } = TONES[toast.tone];

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  return (
    <div
      data-toast=""
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      className={cx(
        'pointer-events-auto flex w-full max-w-[30rem] items-center gap-3 rounded-ui border border-ui-line px-3.5 py-2 text-ui-md leading-[1.45] text-ui-ink [box-shadow:var(--t-shadow)] full-motion:animate-slide-up',
        background,
      )}
    >
      <span className={cx('flex shrink-0', iconColour)}>
        <Icon {...iconSize('lg')} aria-hidden="true" />
      </span>
      {/* The alert is the text alone, so screen readers do not read the buttons out with it. */}
      <span role={toast.tone === 'error' ? 'alert' : undefined} className="min-w-0 flex-1 py-2.5">
        {toast.text}
      </span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          onClick={() => {
            toast.onAction?.();
            onDismiss(toast.id);
          }}
          className={cx(
            'min-h-11 shrink-0 rounded-ui border border-ui-line bg-ui-surface px-3 font-semibold text-ui-ink hover:bg-ui-raised',
            FOCUS_RING,
          )}
        >
          {toast.actionLabel}
        </button>
      )}
      {toast.tone === 'error' && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={() => onDismiss(toast.id)}
          className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-ui text-ui-ink hover:bg-ui-raised', FOCUS_RING)}
        >
          <X {...iconSize('md')} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Calls `onDone` after `ms` of time not paused; `null` never ends. */
function useCountdown(ms: number | null, paused: boolean, onDone: () => void) {
  const remaining = useRef(ms);
  const done = useRef(onDone);
  useLayoutEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const left = remaining.current;
    if (paused || left === null || !Number.isFinite(left)) return;
    const started = Date.now();
    const timer = setTimeout(() => done.current(), left);
    return () => {
      clearTimeout(timer);
      remaining.current = left - (Date.now() - started);
    };
  }, [paused]);
}
