/**
 * What Solicitudes takes from the app (uso responsable UR-4): the backend's
 * commands for the requests and the event that says their count changed.
 * Injected, so the tests pass fakes. Blocking from a request is the shell's
 * `BlockDialogApi`, with `{ kind: 'request' }`.
 */
import type { RequestsChangedEvent, RequestsView } from '../../lib/api';

export interface RequestsApi {
  listRequests(): Promise<RequestsView>;
  /** Answers the new contact's name; rejects with `key_clash` or `not_found`. */
  acceptRequest(key: string): Promise<{ handle: string }>;
  deleteRequest(key: string): Promise<void>;
  /** Resolves to the function that stops listening. */
  onRequestsChanged(cb: (event: RequestsChangedEvent) => void): Promise<() => void>;
}
