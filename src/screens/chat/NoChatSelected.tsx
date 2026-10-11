/**
 * The chat pane while no chat is open, beside the list: one quiet line, with
 * the icon of the conversations. Nothing to do here but choose one.
 */
import { MessagesSquare } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { iconSize } from '../../ui';

export function NoChatSelected() {
  const t = useT();
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-ui-surface p-6 text-center text-ui-muted">
      <MessagesSquare {...iconSize('2xl')} aria-hidden="true" />
      <p className="max-w-[22rem] text-ui-base">{t('chat2.noChat')}</p>
    </section>
  );
}
