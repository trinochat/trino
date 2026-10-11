/** Why the unlock screen shows (Unlock:55): Trino just started, locked itself or was locked. */
import type { TFunction } from '../../../lib/i18n';
import type { LockReason } from '../../types';

export function lockReasonText(reason: LockReason, t: TFunction): string {
  switch (reason.kind) {
    case 'cold':
      return t('unlock2.coldStart');
    case 'manual':
      return t('unlock2.lockedManual');
    case 'idle':
      return reason.minutes === 1 ? t('unlock2.lockedIdleOne') : t('unlock2.lockedIdle', { n: reason.minutes });
  }
}
