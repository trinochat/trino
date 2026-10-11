/**
 * The emoji of the picker: a short list for everyday chat, without weapons,
 * pills, blood or bugs. For anything else there is the system's own panel,
 * which the picker mentions (Win + . on Windows). Each group fills whole rows
 * of EMOJI_COLUMNS, so the arrows go straight up and down across groups.
 * The emoji are their own accessible names: screen readers say their names.
 */
export const EMOJI_COLUMNS = 6;

export type EmojiGroupId = 'faces' | 'gestures' | 'hearts' | 'nature' | 'food' | 'things' | 'symbols';

export interface EmojiGroup {
  /** Its title is `emoji.group.<id>`. */
  id: EmojiGroupId;
  emojis: readonly string[];
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    id: 'faces',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅',
      '😂', '🤣', '🙂', '🙃', '😉', '😊',
      '😍', '🥰', '😘', '😋', '😎', '🤩',
      '🥳', '🤔', '🤗', '🙄', '😴', '😮',
      '😐', '😬', '😳', '😢', '😭', '😡',
    ],
  },
  {
    id: 'gestures',
    emojis: ['👍', '👎', '👏', '🙌', '🙏', '👋', '🤝', '💪', '👌', '✌️', '🤞', '👀'],
  },
  {
    id: 'hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '💔', '💕', '💖'],
  },
  {
    id: 'nature',
    emojis: ['🐶', '🐱', '🐦', '🦋', '🌸', '🌻', '🌴', '🍀', '🌞', '🌙', '🌈', '🔥'],
  },
  {
    id: 'food',
    emojis: ['☕', '🍕', '🍔', '🌮', '🍟', '🍦', '🍰', '🎂', '🍎', '🍌', '🥑', '🍻'],
  },
  {
    id: 'things',
    emojis: ['🎉', '🎁', '🎈', '⚽', '🎵', '🎮', '📷', '💻', '📱', '📚', '✏️', '⏰'],
  },
  {
    id: 'symbols',
    emojis: ['✅', '❌', '❓', '❗', '💯', '✨', '💤', '🆗', '➡️', '⬅️', '🔒', '🔑'],
  },
];
