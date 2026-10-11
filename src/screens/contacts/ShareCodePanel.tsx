/**
 * "Mi código" (Contacts:83-105): your contact code as a QR code and as text,
 * with "Copiar código" and "Guardar QR", and your key. It works on its own,
 * since Settings shows it too as "Tu código QR" (renderShareCode), so it
 * loads what it shows and needs no dialog around it.
 *
 * Only `trino2:` is shared (toShareCode). The QR code sits in QR_FRAME,
 * black on white in every theme and under forced colours; the frame gives
 * it its size in rem, and the PNG of "Guardar QR" comes from a QRCodeCanvas
 * drawn off screen at file resolution, in the QR tokens' colours.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { CircleAlert, Copy, Download } from 'lucide-react';
import { Button, QR_FRAME, cx, iconSize } from '../../ui';
import { formatFingerprint, toShareCode } from '../../lib/contact-code';
import { useT } from '../../lib/i18n';
import type { ContactsApi } from './contacts-api';
import { QR_PNG_COLORS, QR_PNG_MARGIN, QR_PNG_SIZE, qrFileName, saveQrPng } from './qr';
import { ERROR_LINE, LABEL, MONO_KEY } from './styles';

export interface ShareCodePanelProps {
  api: Pick<ContactsApi, 'shareBundle' | 'getProfile'>;
  /** Saves a file for the person, such as the QR code's PNG. */
  download(name: string, blob: Blob): void;
  /**
   * More ways to share, under "Copiar código" and "Guardar QR": the seam for
   * "Crear enlace" of the invitations (plan-cambios-11oct §8). Nothing today.
   */
  extraActions?: ReactNode;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; code: string; name: string; fingerprint: string | null };

type Notice = 'copied' | 'copyFailed' | 'saveFailed' | null;

/** The name inside a bundle, for the PNG's file name when the profile cannot be read. */
function bundleName(bundleJson: string): string {
  try {
    const handle: unknown = JSON.parse(bundleJson)?.handle;
    return typeof handle === 'string' ? handle : '';
  } catch {
    return '';
  }
}

export function ShareCodePanel({ api, download, extraActions }: ShareCodePanelProps) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Loaded once, and again on Reintentar: not because the parent passed the
  // same API in a new object.
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  });

  useEffect(() => {
    let live = true;
    setLoaded({ status: 'loading' });
    const current = apiRef.current;
    void Promise.allSettled([current.shareBundle(), current.getProfile()]).then(([bundle, profile]) => {
      if (!live) return;
      const code = bundle.status === 'fulfilled' ? toShareCode(bundle.value) : '';
      if (bundle.status !== 'fulfilled' || code === '') {
        setLoaded({ status: 'failed' });
        return;
      }
      setLoaded({
        status: 'ready',
        code,
        name: profile.status === 'fulfilled' ? profile.value.handle : bundleName(bundle.value),
        fingerprint: profile.status === 'fulfilled' ? profile.value.fingerprint : null,
      });
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  if (loaded.status === 'loading') {
    return (
      <p role="status" className="m-0 text-ui-md text-ui-muted">
        {t('contacts.share.loading')}
      </p>
    );
  }
  if (loaded.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{t('contacts.share.failed')}</span>
        </p>
        <Button onClick={() => setAttempt(n => n + 1)}>{t('common2.retry')}</Button>
      </div>
    );
  }

  const { code, name, fingerprint } = loaded;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setNotice('copied');
    } catch {
      setNotice('copyFailed');
    }
  };
  const save = async () => {
    setNotice((await saveQrPng(canvasRef.current, qrFileName(name), download)) ? null : 'saveFailed');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-5">
        <div role="img" aria-label={t('contacts.share.qr')} className={cx(QR_FRAME, 'w-[11.5rem] shrink-0')}>
          <QRCodeSVG value={code} level="L" fgColor="currentColor" bgColor="transparent" className="h-full w-full" aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-[1_1_13.75rem] flex-col gap-2">
          <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('contacts.mutualNote')}</p>
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('contacts.share.safe')}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-ui border border-ui-line bg-ui-bg p-3.5">
        <span className={LABEL}>{t('contacts.share.codeLabel')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-[1_1_12.5rem] truncate font-ui-mono text-ui-md text-ui-ink">{code}</code>
          <Button leadingIcon={<Copy {...iconSize('md')} aria-hidden="true" />} onClick={() => void copy()}>
            {t('contacts.share.copy')}
          </Button>
          <Button leadingIcon={<Download {...iconSize('md')} aria-hidden="true" />} onClick={() => void save()}>
            {t('contacts.share.saveQr')}
          </Button>
        </div>
        <p role="status" className={cx('m-0 text-ui-md text-ui-muted', notice !== 'copied' && 'sr-only')}>
          {notice === 'copied' ? t('contacts.share.copied') : ''}
        </p>
        {(notice === 'copyFailed' || notice === 'saveFailed') && (
          <p role="alert" className={ERROR_LINE}>
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{t(notice === 'copyFailed' ? 'contacts.share.copyFailed' : 'contacts.share.saveFailed')}</span>
          </p>
        )}
        {extraActions != null && extraActions !== false && (
          <div data-extra-actions="" className="flex flex-wrap gap-2">
            {extraActions}
          </div>
        )}
      </div>

      {fingerprint && (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>{t('contacts.share.yourKey')}</span>
          <code className={MONO_KEY}>{formatFingerprint(fingerprint)}</code>
          <span className="text-ui-md text-ui-muted">{t('contacts.share.keyNote')}</span>
        </div>
      )}

      {/* The PNG of "Guardar QR", at file resolution, never on screen. */}
      <div hidden>
        <QRCodeCanvas
          ref={canvasRef}
          value={code}
          level="L"
          size={QR_PNG_SIZE}
          marginSize={QR_PNG_MARGIN}
          fgColor={QR_PNG_COLORS.ink}
          bgColor={QR_PNG_COLORS.paper}
        />
      </div>
    </div>
  );
}
