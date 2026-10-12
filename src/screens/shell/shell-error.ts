/**
 * What the banner over the shell says about a failure that has no message of
 * its own on screen. A file forward is shown in its chat only once it went
 * out, so its failure is said here, with the reason forward_file gave (B2):
 *
 * - `offline`: no relay was up, and it checks that before anything goes out;
 * - `too_long`: the file's message does not fit the relays;
 * - anything else: in a group it sends to the members one by one without
 *   waiting for an OK, so the ones before the failure may have it.
 */
import type { TFunction } from '../../lib/i18n';
import type { ShellError } from './useConversations';

export function shellErrorText(t: TFunction, error: ShellError): string {
  if (error.kind === 'reconnect') return t('shell.error.reconnect', { name: error.handle });
  if (error.reason === 'offline') return t('shell.error.forwardOffline');
  if (error.reason === 'too_long') return t('shell.error.forwardTooLong');
  return t(error.group ? 'shell.error.forwardGroup' : 'shell.error.forward');
}
