/**
 * "Todo listo" (Onboarding:174-193): the contact code to share, with Copiar
 * and "Mostrar QR", and the two ways on. The code is `toShareCode`, which W4
 * moves to trino2:. The copy is honest: both people add each other with
 * their codes, since there are no message requests in this batch. When the
 * photo could not be saved, it says so without stopping anyone.
 */
import { Check, Copy, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState, type Ref } from 'react';
import { toShareCode } from '../../../../lib/contact-code';
import { useT } from '../../../../lib/i18n';
import { Banner, Button, Dialog, QR_FRAME, cx, iconSize } from '../../../../ui';
import type { OnboardingIntent } from '../../../types';
import { LABEL_TEXT } from '../../common/styles';
import type { OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

/** How long "Copiado" stays, in ms. */
const COPIED_MS = 2000;

export interface DoneStepProps {
  state: OnboardingState;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  onFinish(intent: OnboardingIntent): void;
}

export function DoneStep({ state, headingId, headingRef, onFinish }: DoneStepProps) {
  const t = useT();
  const code = state.created ? toShareCode(state.created.bundle_json) : '';
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    clipboard.writeText(code).then(
      () => setCopied(true),
      () => console.warn('copying the contact code failed'),
    );
  };

  return (
    <div className="flex flex-col gap-[1.125rem]">
      <StepHeader ref={headingRef} id={headingId} large title={t('onb.doneTitle')} body={t('onb.doneBody')} />
      {state.photoSave === 'failed' ? <Banner tone="warn">{t('onb.errPhotoSave')}</Banner> : null}
      <div className="flex flex-col gap-2 rounded-ui border border-ui-line bg-ui-bg p-3.5">
        <span className={LABEL_TEXT}>{t('onb.yourCode')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-[1_1_12rem] truncate font-ui-mono text-ui-md text-ui-ink">{code}</code>
          <Button
            leadingIcon={copied ? <Check {...iconSize('md')} /> : <Copy {...iconSize('md')} />}
            onClick={copy}
          >
            {copied ? t('onb.copied') : t('onb.copy')}
          </Button>
          <Button leadingIcon={<QrCode {...iconSize('md')} />} onClick={() => setQrOpen(true)}>
            {t('onb.showQr')}
          </Button>
        </div>
        <span role="status" className="sr-only">
          {copied ? t('onb.copied') : ''}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="lg" className="flex-[1_1_11.25rem]" onClick={() => onFinish('add-contact')}>
          {t('onb.addFirst')}
        </Button>
        <Button size="lg" className="flex-[1_1_11.25rem]" onClick={() => onFinish('chats')}>
          {t('onb.goChats')}
        </Button>
      </div>
      <Dialog open={qrOpen} onClose={() => setQrOpen(false)} title={t('onb.qrTitle')} closeLabel={t('common2.close')} size="sm">
        <div role="img" aria-label={t('onb.codeQr')} className={cx(QR_FRAME, 'w-[15rem] max-w-full self-center')}>
          <QRCodeSVG value={code} size={256} fgColor="currentColor" bgColor="transparent" className="h-full w-full" aria-hidden="true" />
        </div>
      </Dialog>
    </div>
  );
}
