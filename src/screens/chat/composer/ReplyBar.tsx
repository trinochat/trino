/**
 * Over the composer while you reply: who and what you reply to, behind the
 * accent bar a quote has, and a button to take the reply back (Escape in
 * the text box does the same). The button goes with the bar, so the focus
 * it held goes to the text box.
 */
import { X } from 'lucide-react';
import { useT } from '../../../lib/i18n';
import { IconButton, iconSize } from '../../../ui';
import type { ReplyRef } from '../../types';

export interface ReplyBarProps {
  reply: ReplyRef;
  onCancel(): void;
  /** Puts the focus in the text box. */
  focusBox(): void;
}

export function ReplyBar({ reply, onCancel, focusBox }: ReplyBarProps) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-ui bg-ui-raised py-1 pe-1 ps-3">
      <div className="flex min-w-0 flex-1 flex-col border-s-2 border-ui-accent-text ps-2 text-ui-sm">
        <span className="font-semibold text-ui-accent-text [overflow-wrap:anywhere]">
          {t('composer2.replyingTo', { author: reply.author })}
        </span>
        <span className="truncate text-ui-muted">{reply.preview}</span>
      </div>
      <IconButton
        aria-label={t('composer2.cancelReply')}
        variant="muted"
        icon={<X {...iconSize('lg')} />}
        onClick={event => {
          const focused = event.currentTarget === document.activeElement;
          onCancel();
          if (focused) focusBox();
        }}
      />
    </div>
  );
}
