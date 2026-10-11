/**
 * Told once (parent decision of 11 Oct): the "verified" marks of 0.1.0 came
 * from the weak checks (comparing the contact's emojis) and no longer count.
 * It names the contacts that had one and says how to verify them again: by
 * calling and comparing the call's symbols, the way this device has. The
 * desktop cannot scan a QR, so it does not offer that way.
 *
 * The integration shows it while `legacyMarks` (verification-marks.ts)
 * finds old marks, and on close clears them, so it never comes back.
 */
import { useT } from '../../lib/i18n';
import { Button, Dialog } from '../../ui';

export interface LegacyVerificationNoticeProps {
  /** The contacts whose old mark no longer counts; nothing shows without any. */
  names: readonly string[];
  onClose(): void;
}

export function LegacyVerificationNotice({ names, onClose }: LegacyVerificationNoticeProps) {
  const t = useT();
  if (names.length === 0) return null;
  return (
    <Dialog open onClose={onClose} title={t('verify.legacy.title')} description={t('verify.legacy.body')}>
      <ul aria-label={t('verify.legacy.list')} className="m-0 flex list-disc flex-col gap-1 pl-5 text-ui-base">
        {names.map(name => (
          <li key={name} className="[overflow-wrap:anywhere]">
            {name}
          </li>
        ))}
      </ul>
      <p className="m-0 text-ui-base leading-normal">{t('verify.legacy.howTo')}</p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={onClose}>
          {t('verify.legacy.ok')}
        </Button>
      </div>
    </Dialog>
  );
}
