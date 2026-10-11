/**
 * The texts of the settings (settings2.*) and of the contact details
 * (contactInfo.*). W5 owns this area; its contract is settings.test.ts.
 * Spanish is natural Colombian Spanish with "tú".
 */
import type { AreaStrings } from './types';

export const settings: AreaStrings = {
  es: {
    // What a message notification says (notification-content.ts).
    'settings2.notif.appName': 'Trino Chat',
    'settings2.notif.newMessage': 'Nuevo mensaje',
    'settings2.notif.newFile': 'Te envió un archivo',
    'settings2.notif.newSticker': 'Te envió un sticker',
  },
  en: {
    'settings2.notif.appName': 'Trino Chat',
    'settings2.notif.newMessage': 'New message',
    'settings2.notif.newFile': 'Sent you a file',
    'settings2.notif.newSticker': 'Sent you a sticker',
  },
  pt: {
    'settings2.notif.appName': 'Trino Chat',
    'settings2.notif.newMessage': 'Nova mensagem',
    'settings2.notif.newFile': 'Enviou um arquivo para você',
    'settings2.notif.newSticker': 'Enviou uma figurinha para você',
  },
};
