import type { ReactNode } from 'react';

/** Whether an optional label, hint or description renders anything, so its id may be referenced. */
export function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/** Space-separated ids for aria-describedby and the like, or undefined when there are none. */
export function joinIds(...ids: Array<string | false | null | undefined>): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined;
}
