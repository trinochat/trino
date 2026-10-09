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
  /** Width and height in px. Default 44. */
  size?: AvatarSize;
  /** Default `person`. */
  kind?: AvatarKind;
  /** Accessible name; without it the avatar is decoration beside a visible name. */
  alt?: string;
  className?: string;
}

const SIZES: Record<AvatarSize, string> = {
  36: 'h-9 w-9 text-[14px]',
  40: 'h-10 w-10 text-[14px]',
  44: 'h-11 w-11 text-[15px]',
  48: 'h-12 w-12 text-[16px]',
  64: 'h-16 w-16 text-[24px]',
  80: 'h-20 w-20 text-[30px]',
  96: 'h-24 w-24 text-[32px]',
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
