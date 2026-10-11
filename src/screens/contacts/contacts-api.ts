/**
 * What the contacts screens ask of the backend (plan §3, W4). `api` from
 * src/lib/api.ts fits it; the tests pass a fake, so nothing mocks `invoke`.
 */
import type { ContactPreview, GroupInfo, NodeInfo, ProfileResponse } from '../../lib/api';

export interface ContactsApi {
  shareBundle(): Promise<string>;
  getProfile(): Promise<ProfileResponse>;
  /** Checks a code's signatures without saving it (K8). */
  previewContact(bundleJson: string): Promise<ContactPreview>;
  /** Saves the contact; `replaceExisting` only after the person said yes (K8). */
  probeNode(bundleJson: string, handle: string, replaceExisting?: boolean): Promise<NodeInfo>;
  acceptGroupInvite(gid: string): Promise<GroupInfo>;
  declineGroupInvite(gid: string): Promise<void>;
}
