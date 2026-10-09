/**
 * Row maths of the autosizing Textarea, pure so it can be tested without a
 * layout engine (jsdom has none).
 */

/** What the browser reports about a textarea collapsed to one row. */
export interface TextareaMetrics {
  /** scrollHeight in px: the content plus the padding. */
  scrollHeight: number;
  /** Computed line-height in px. */
  lineHeight: number;
  /** Top plus bottom padding in px. */
  paddingBlock: number;
}

/**
 * The lines the text takes: measured from the scroll height when there is a
 * layout, which counts soft-wrapped lines; otherwise its line breaks.
 */
export function contentRows(text: string, metrics?: TextareaMetrics): number {
  const breaks = text.split('\n').length;
  if (!metrics) return breaks;
  const { scrollHeight, lineHeight, paddingBlock } = metrics;
  if (!(scrollHeight > 0) || !(lineHeight > 0) || !Number.isFinite(paddingBlock)) return breaks;
  // Round, not ceil: sub-pixel layout leaves a fraction that is not a line.
  return Math.max(1, Math.round((scrollHeight - paddingBlock) / lineHeight));
}

/** The rows for the text: its lines, at least `minRows` (and 1) and at most `maxRows`. */
export function autosizeRows(text: string, minRows: number, maxRows: number, metrics?: TextareaMetrics): number {
  const floor = Math.max(1, Math.floor(minRows));
  const ceiling = Math.max(floor, Math.floor(maxRows));
  return Math.min(ceiling, Math.max(floor, contentRows(text, metrics)));
}
