/**
 * The options of a message (Main:200-210), on yours and on theirs (plan §1.8,
 * deviation 3): Responder, Copiar when it has text, Reenviar, and Borrar para
 * mí when the backend keeps it deleted (K11). There is no "Borrar para
 * todos": it would need a new message type the 0.1.0 shows as JSON (plan §1.2).
 * Borrar para mí cannot be undone, so it is the danger item, and the chat
 * asks before it goes.
 */
import { useT } from '../../lib/i18n';
import { Menu, type MenuItem } from '../../ui';

export interface MessageMenuProps {
  onReply(): void;
  /** Only for a message with text. */
  onCopy?(): void;
  onForward(): void;
  /** Only when the backend can delete it for good (K11). */
  onDelete?(): void;
  /** The edge of the trigger the menu lines up with: the bubble's side. */
  align: 'start' | 'end';
  className?: string;
}

export function MessageMenu({ onReply, onCopy, onForward, onDelete, align, className }: MessageMenuProps) {
  const t = useT();
  const items: MenuItem[] = [{ id: 'reply', label: t('msg2.reply'), onSelect: onReply }];
  if (onCopy) items.push({ id: 'copy', label: t('common2.copy'), onSelect: onCopy });
  items.push({ id: 'forward', label: t('msg2.forward'), onSelect: onForward });
  if (onDelete) items.push({ id: 'delete', label: t('msg2.deleteForMe'), tone: 'danger', onSelect: onDelete });
  return <Menu label={t('msg2.options')} items={items} align={align} className={className} />;
}
