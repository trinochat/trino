// The component library of the redesign, in one import. Every visible string
// comes in through props, so the screens own their translations.
export { cx } from './cx';
// The one focus ring, and what Tab reaches, for pieces the screens build themselves.
export { FOCUS_RING, FOCUS_RING_INSET, focusableWithin } from './focus';
// The size of every lucide icon: `<Check {...iconSize('md')} />` (src/design/type.ts).
export { iconSize, type IconSizeName, type IconSizeProps } from '../design/type';
// The frame of a QR code, black on white in every theme and under forced colours.
export { QR_FRAME } from './qr';
// Form controls and buttons.
export * from './controls';
// Overlays.
export { Dialog, type DialogProps } from './overlay/Dialog';
export { Menu, type MenuEntry, type MenuItem, type MenuProps, type MenuSeparator } from './overlay/Menu';
// The items and box both menus share, for a screen that lists the same entries.
export { MENU_BOX, MenuEntries, isSeparator, moveInMenu, type MenuEntriesProps } from './overlay/menu-parts';
export {
  placeMenu,
  useContextMenu,
  type ContextMenuBuild,
  type ContextMenuHandle,
  type ContextMenuRequest,
} from './overlay/ContextMenu';
// Where the person types, which keeps the system's own right-click menu.
export { isEditableTarget } from './editable';
export {
  ToastProvider,
  useToast,
  type ToastApi,
  type ToastOptions,
  type ToastProviderProps,
  type ToastTone,
} from './overlay/Toast';
// Chat and inbox pieces.
export { Avatar, type AvatarKind, type AvatarProps, type AvatarSize } from './chat/Avatar';
export { Banner, type BannerProps, type BannerTone } from './chat/Banner';
export { ChatRow, type ChatRowProps } from './chat/ChatRow';
export { ConnectionChip, type ConnectionChipProps, type ConnectionStatus } from './chat/ConnectionChip';
export { DaySeparator, type DaySeparatorProps } from './chat/DaySeparator';
export { MessageBubble, type MessageBubbleProps } from './chat/MessageBubble';
export { StatusTicks, type MessageStatus, type StatusTicksProps } from './chat/StatusTicks';
export { TrustBadge, type TrustBadgeProps, type TrustKind } from './chat/TrustBadge';
export { UnreadBadge, type UnreadBadgeProps, type UnreadBadgeVariant } from './chat/UnreadBadge';
// Brand.
export { TrinoLogo, type TrinoLogoProps } from './brand/TrinoLogo';
