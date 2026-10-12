/**
 * How the chats tell of a message that arrives where you are not looking
 * (plan §4, I6). W2's shell decides when: the message's chat is not on
 * screen, or Trino is not in front, and its group is not muted. This
 * decides how, with what Settings > Notificaciones chose (W5):
 *
 * - While Trino is not in front, a notification of the system, through the
 *   backend (`notify` of src/lib/api.ts), showing what Settings allows:
 *   the name and the message, only the name, or nothing but "Nuevo
 *   mensaje" (notificationContent, W5). That notification makes the
 *   system's own sound.
 * - While Trino is in front, the message tone of W6 instead, unless
 *   "Sonido de mensajes" is off. Settings has no volume for it, since its
 *   slider is the ringtone's: the tone plays at its own level.
 * - A group muted on this device makes neither (W4, plan §1.4). The shell
 *   already leaves it out; the notifier holds to the mark as well.
 *
 * Settings is read at each message, so a change applies to the next one.
 */
import type { TFunction } from '../lib/i18n';
import type { Prefs } from '../lib/prefs';
import { notificationContent } from '../screens/settings/notification-content';
import type { Notifier } from '../screens/types';

export interface NotifierDeps {
  /** What Settings > Notificaciones chose, and the groups muted on this device. */
  prefs: Pick<Prefs, 'getMessageSound' | 'getNotifPreview' | 'getGroupMuted'>;
  /** The texts of the language on screen. */
  t: TFunction;
  /** A notification of the system, through the backend; `notify` of src/lib/api.ts. */
  notify(title: string, body: string): Promise<void>;
  /** The message tone; `playMessageTone` of src/lib/sfx.ts. */
  tone(): void;
  /** Whether Trino is in front, as the window's focus says. */
  isWindowFocused(): boolean;
}

export function createNotifier({ prefs, t, notify, tone, isWindowFocused }: NotifierDeps): Notifier {
  return {
    message: ({ convo, ...message }) => {
      if (convo.kind === 'group' && prefs.getGroupMuted(convo.gid)) return;
      if (isWindowFocused()) {
        if (prefs.getMessageSound()) tone();
        return;
      }
      const { title, body } = notificationContent(prefs.getNotifPreview(), message, t);
      notify(title, body).catch(() => {
        // The system refused the notification: the message is in its chat all the same.
      });
    },
  };
}
