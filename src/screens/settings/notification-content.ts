/**
 * What a message notification shows at the level chosen in Settings >
 * Notifications (Settings:53-85), for the shell's notifier (I6), which sends
 * it with `api.notify`:
 *
 * - `full`, "Nombre y mensaje": who writes and the text, or what was sent;
 * - `name`, "Solo el nombre" (the default): who writes, not what;
 * - `none`, "Nada": only "Trino Chat: Nuevo mensaje".
 *
 * Never an avatar: the picture a Windows notification would show is not
 * verified, so the result has a title and a body and nothing else.
 */
import type { TFunction } from '../../lib/i18n';
import type { NotifPreview } from '../../lib/prefs';

export type { NotifPreview };

/** A message as the notifier describes it: the chat's name, and the text or what kind of thing came. */
export interface NotificationMessage {
  title: string;
  text?: string;
  kind: 'text' | 'file' | 'sticker';
}

export interface NotificationContent {
  title: string;
  body: string;
}

export function notificationContent(level: NotifPreview, n: NotificationMessage, t: TFunction): NotificationContent {
  const newMessage = t('settings2.notif.newMessage');
  if (level === 'none') return { title: t('settings2.notif.appName'), body: newMessage };
  if (level === 'name') return { title: n.title, body: newMessage };
  if (n.kind === 'file') return { title: n.title, body: t('settings2.notif.newFile') };
  if (n.kind === 'sticker') return { title: n.title, body: t('settings2.notif.newSticker') };
  const text = n.text?.trim();
  return { title: n.title, body: text ? text : newMessage };
}
