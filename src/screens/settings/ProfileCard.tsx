/**
 * Your card at the top of Settings (PropAjustes:44-53): your photo and name,
 * which open your profile, and a button that opens "Tu código QR". The card
 * is tinted while either is on screen; the control on screen says so with
 * aria-current, and under forced colours the card keeps a highlighted
 * border, since the tint is lost there.
 *
 * `findableName` is the @name people find you by: ready for the invitations
 * unit (plan-cambios-11oct §8), and empty in this batch, so no @name shows.
 */
import { QrCode } from 'lucide-react';
import type { Ref } from 'react';
import { useT } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';
import { Avatar, cx, FOCUS_RING, FOCUS_RING_INSET, iconSize } from '../../ui';

export interface ProfileCardProps {
  name: string;
  avatar?: string | null;
  /** Your @name, once names exist (§8). Left out in this batch. */
  findableName?: string;
  /** The profile is on screen. */
  current: boolean;
  /** "Tu código QR" is on screen. */
  qrCurrent: boolean;
  onOpenProfile(): void;
  onOpenQr(): void;
  /** The button that opens your profile, for the focus to come back to it. */
  profileRef?: Ref<HTMLButtonElement>;
  /** The button that opens your QR code, for the same. */
  qrRef?: Ref<HTMLButtonElement>;
}

export function ProfileCard({
  name,
  avatar,
  findableName,
  current,
  qrCurrent,
  onOpenProfile,
  onOpenQr,
  profileRef,
  qrRef,
}: ProfileCardProps) {
  const t = useT();
  const open = current || qrCurrent;
  return (
    <div
      className={cx(
        'flex min-w-0 items-center gap-1 rounded-ui-lg border border-ui-line p-1.5',
        open ? 'bg-ui-raised forced-colors:border-[color:Highlight]' : 'bg-ui-surface',
      )}
    >
      <button
        ref={profileRef}
        type="button"
        aria-current={current ? 'page' : undefined}
        onClick={onOpenProfile}
        className={cx(
          'flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-ui p-2 text-left font-ui text-ui-ink',
          FOCUS_RING_INSET,
        )}
      >
        <Avatar size={48} src={avatar ?? undefined} initials={identityInitials(name)} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-ui-lg font-bold">{name}</span>
          {findableName ? (
            <span className="truncate font-ui-mono text-ui-sm text-ui-muted">@{findableName}</span>
          ) : (
            <span className="truncate text-ui-sm text-ui-muted">{t('settings2.nav.profile')}</span>
          )}
        </span>
      </button>
      <button
        ref={qrRef}
        type="button"
        aria-label={t('settings2.nav.profileQr')}
        aria-current={qrCurrent ? 'page' : undefined}
        onClick={onOpenQr}
        className={cx(
          'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-ui border text-ui-ink',
          qrCurrent
            ? 'border-ui-accent-text bg-ui-accent-soft forced-colors:border-[color:Highlight]'
            : 'border-ui-line bg-transparent hover:bg-ui-surface',
          FOCUS_RING,
        )}
      >
        <QrCode {...iconSize('lg')} aria-hidden="true" />
      </button>
    </div>
  );
}
