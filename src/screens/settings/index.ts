/**
 * Settings (W5). The integration mounts SettingsScreen in the settings slot
 * of the shell (I2, I6) with the real API, and the notifier (I6) uses
 * notificationContent with the level chosen in Notificaciones.
 */
export { formatKey } from './format-key';
export {
  notificationContent,
  type NotificationContent,
  type NotificationMessage,
  type NotifPreview,
} from './notification-content';
export { SettingsScreen } from './SettingsScreen';
export type { SettingsApi, SettingsCapabilities, SettingsPlatform, SettingsScreenProps } from './types';
