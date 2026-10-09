import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../cx';
import { autosizeRows, contentRows } from './autosize';
import { useFieldControl } from './field-context';
import { DISABLED, FIELD_BOX, FOCUS_RING, fieldBorder } from './styles';

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  /** Rows while empty: 2 by default. */
  minRows?: number;
  /** Rows before it scrolls: 6 by default. */
  maxRows?: number;
  /** The monospace font, for keys and codes only. */
  mono?: boolean;
}

/**
 * A textarea that grows with its text between `minRows` and `maxRows`, then
 * scrolls. One row is 44 px. Key handlers pass through, so the composer can
 * send on Enter and break the line on Shift+Enter.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { minRows = 2, maxRows = 6, mono = false, className, onChange, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const { controlProps, invalid } = useFieldControl(rest);

  const resize = useCallback(() => {
    const element = inner.current;
    if (!element) return;
    // Measure with a single row, so the scroll height is the content's.
    element.rows = 1;
    const style = window.getComputedStyle(element);
    const metrics = {
      scrollHeight: element.scrollHeight,
      lineHeight: parseFloat(style.lineHeight),
      paddingBlock: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
    };
    element.rows = autosizeRows(element.value, minRows, maxRows, metrics);
    element.style.overflowY = contentRows(element.value, metrics) > element.rows ? 'auto' : 'hidden';
  }, [minRows, maxRows]);

  // Controlled values change from outside too: a draft restored, a sent message cleared.
  useLayoutEffect(resize, [resize, rest.value]);

  // A new width wraps the text differently.
  useEffect(() => {
    const element = inner.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inner.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(event);
    resize();
  };

  return (
    <textarea
      ref={setRefs}
      rows={minRows}
      {...rest}
      {...controlProps}
      onChange={handleChange}
      className={cx(
        'block resize-none px-3.5 py-[9px] leading-6',
        FIELD_BOX,
        mono ? 'font-ui-mono' : 'font-ui',
        fieldBorder(invalid),
        FOCUS_RING,
        DISABLED,
        className,
      )}
    />
  );
});
