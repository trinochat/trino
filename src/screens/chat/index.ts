// The chat of the redesign (W3, R5): what the shell mounts in its `chat` slot,
// what it shows with no chat open, and what its sending needs from here.
export { ChatPane } from './ChatPane';
export { NoChatSelected } from './NoChatSelected';
// The shell sends a sticker with `stickerThumb(s)` as its inline picture.
export { STICKER_INLINE_MAX, stickerThumb } from './composer/sticker-limits';
export { composerKeyAction, type ComposerKeyAction } from './composer/composer-keys';
export { withDaySeparators, type LogItem } from './day';
