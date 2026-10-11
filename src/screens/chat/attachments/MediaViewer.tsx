/**
 * A picture or a video of a message, in large: a dialog named after the file,
 * with Descargar and Cerrar. The Dialog of src/ui keeps the focus inside,
 * closes with Escape and gives the focus back to what opened it. A video
 * plays only when asked, with its own controls.
 */
import { Download } from 'lucide-react';
import { useT } from '../../../lib/i18n';
import { Button, Dialog, iconSize } from '../../../ui';

export interface MediaViewerProps {
  open: boolean;
  /** The file's name, which names the dialog. */
  name: string;
  /** The whole file, as a safe inline data URL (safe-media.ts). */
  url: string;
  video: boolean;
  onClose(): void;
  onDownload(): void;
}

export function MediaViewer({ open, name, url, video, onClose, onDownload }: MediaViewerProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={<span className="[overflow-wrap:anywhere]">{name}</span>}
      closeLabel={t('common2.close')}
      size="lg"
    >
      {video ? (
        <video src={url} controls className="max-h-[70vh] w-full rounded-ui bg-ui-raised" />
      ) : (
        <img src={url} alt={name} className="max-h-[70vh] w-full rounded-ui object-contain" />
      )}
      <div className="flex justify-end">
        <Button onClick={onDownload} leadingIcon={<Download {...iconSize('md')} aria-hidden="true" />}>
          {t('media.download')}
        </Button>
      </div>
    </Dialog>
  );
}
