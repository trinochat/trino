/**
 * The options of a message (Main:200-210), on yours and on theirs (plan §1.8,
 * deviation 3): Responder, Copiar when it has text, Reenviar, and Borrar para
 * mí when the backend keeps it deleted (K11); on theirs, Reportar beside it
 * (UR-5). There is no "Borrar para
 * todos": it would need a new message type the 0.1.0 shows as JSON (plan §1.2).
 * Borrar para mí cannot be undone, so it is the danger item, after a
 * separator, and the chat asks before it goes. Responder is left out where
 * nobody can write: to a contact you blocked, or in a group you are no
 * longer in.
 *
 * The options button and the right-click menu (MC-2) list the same entries,
 * with an icon each, from `messageEntries`. A deletion for everyone, once it
 * exists, joins the items after the separator.
 */
import { Copy, Flag, Forward, Reply, Trash2 } from 'lucide-react';
import { useT, type TFunction } from '../../lib/i18n';
import { Menu, type MenuEntry } from '../../ui';

export interface MessageMenuActions {
  /** Only where you can write. */
  onReply?(): void;
  /** Only for a message with text. */
  onCopy?(): void;
  onForward(): void;
  /** Only when the backend can delete it for good (K11). */
  onDelete?(): void;
  /** Only on a message of theirs (UR-5): next to what deletes, as PropReportar card 1 draws it. */
  onReport?(): void;
}

/** The options of a message, in order: what it does, then a separator and what deletes it. */
export function messageEntries(
  { onReply, onCopy, onForward, onDelete, onReport }: MessageMenuActions,
  t: TFunction,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (onReply) entries.push({ id: 'reply', label: t('msg2.reply'), icon: Reply, onSelect: onReply });
  if (onCopy) entries.push({ id: 'copy', label: t('common2.copy'), icon: Copy, onSelect: onCopy });
  entries.push({ id: 'forward', label: t('msg2.forward'), icon: Forward, onSelect: onForward });
  const deleting: MenuEntry[] = [];
  if (onReport) deleting.push({ id: 'report', label: t('report.action'), icon: Flag, onSelect: onReport });
  if (onDelete) deleting.push({ id: 'delete', label: t('msg2.deleteForMe'), icon: Trash2, tone: 'danger', onSelect: onDelete });
  if (deleting.length > 0) entries.push({ id: 'delete-separator', separator: true }, ...deleting);
  return entries;
}

export interface MessageMenuProps extends MessageMenuActions {
  /** The edge of the trigger the menu lines up with: the bubble's side. */
  align: 'start' | 'end';
  className?: string;
}

export function MessageMenu({ align, className, ...actions }: MessageMenuProps) {
  const t = useT();
  return <Menu label={t('msg2.options')} items={messageEntries(actions, t)} align={align} className={className} />;
}
