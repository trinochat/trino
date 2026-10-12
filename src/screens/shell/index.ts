// The shell of the redesign (W2): the main screen, which mounts the other units through their slots.
export { MAX_TEXT_LENGTH, ShellScreen, type ShellScreenProps } from './ShellScreen';
export type { ShellApi, ShellCapabilities, ShellEvents, ShellPrefs } from './shell-api';
export { sendFailureOf, type ShellError } from './useConversations';
