/**
 * Avatar of a contact, a group or a message request: the picture, or else the
 * initials. Contacts and groups follow the accent (accent-soft with
 * accent-text, at least 4.5:1 in every theme and accent; parent decision
 * R2-B); a request shows "?" in the warning colours.
 */
import { useState } from 'react';
import { cx } from '../cx';

export type AvatarSize = 36 | 40 | 44 | 48 | 64 | 80 | 96;
export type AvatarKind = 'person' | 'group' | 'request';

export interface AvatarProps {
  /** One or two letters. A request always shows "?". */
  initials?: string;
  /** Picture URL; the initials show if it is missing or fails to load. */
  src?: string;
  /** Width and height in px at 100 % text size: a size key, drawn in rem. Default 44. */
  size?: AvatarSize;
  /** Default `person`. */
  kind?: AvatarKind;
  /** Accessible name; without it the avatar is decoration beside a visible name. */
  alt?: string;
  className?: string;
}

/**
 * The box and its initials, both in rem so they grow with the text, the
 * initials in a fixed proportion to the box. The only text sizes off the type
 * scale (src/design/type.ts): they belong to the box, not to the text around.
 */
const SIZES: Record<AvatarSize, string> = {
  36: 'h-9 w-9 text-[0.875rem]',
  40: 'h-10 w-10 text-[0.875rem]',
  44: 'h-11 w-11 text-[0.9375rem]',
  48: 'h-12 w-12 text-[1rem]',
  64: 'h-16 w-16 text-[1.5rem]',
  80: 'h-20 w-20 text-[1.875rem]',
  96: 'h-24 w-24 text-[2rem]',
};

export function Avatar({ initials = '', src, size = 44, kind = 'person', alt, className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const picture = kind !== 'request' && src !== undefined && src !== failedSrc ? src : undefined;
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-bold leading-none',
        SIZES[size],
        shape(kind, size),
        kind === 'request' ? 'bg-ui-warn-bg text-ui-warn' : 'bg-ui-accent-soft text-ui-accent-text',
        className,
      )}
    >
      {picture !== undefined ? (
        <img src={picture} alt="" onError={() => setFailedSrc(picture)} className="h-full w-full object-cover" />
      ) : kind === 'request' ? (
        '?'
      ) : (
        initials
      )}
    </span>
  );
}

/** Contacts and requests take the theme's avatar radius; groups are squared, as in the prototype. */
function shape(kind: AvatarKind, size: AvatarSize): string {
  if (kind !== 'group') return 'rounded-ui-avatar';
  return size >= 64 ? 'rounded-ui-lg' : 'rounded-ui';
}
