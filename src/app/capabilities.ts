/**
 * Which backend pieces of the redesign this build has (plan §4, supplement
 * §7 and §8). A screen whose piece is missing hides that function; it never
 * fakes it. The integration turns a flag on once its piece is in and green.
 */
export interface Capabilities {
  /**
   * K12: your name, photo and "about" reach your contacts encrypted
   * (`profile1`), so the copy can say so (supplement §6).
   */
  profileSync: boolean;
  /** K13: calls are kept in the encrypted chat history ("Llamadas", the call events). */
  callLog: boolean;
  /** K3: the real state of each relay (Settings > Avanzado, and the chats' connection chip). */
  relayStatus: boolean;
  /** K4: a send answers with the receipt of a relay that took it, so a message shows as sent. */
  sendAck: boolean;
  /** K11: "Borrar para mí" deletes a message from the history on this device for good. */
  deleteForMe: boolean;
  /** K5: turning two-step verification on and off (Settings > Cuenta y seguridad). */
  totp: boolean;
  /** K6: a new password for the vault (Settings > Cuenta y seguridad). */
  changePassphrase: boolean;
  /**
   * CE-5: the emergency key's page of Settings > Cuenta y seguridad
   * (configure, test, remove, and the network behind the password).
   */
  emergencyKey: boolean;
  /**
   * K9: the members of a group, matched to your contacts by key (the group's
   * details), and so whom "Invitar" can offer.
   */
  groupMembers: boolean;
  /** K10: removing a member, renaming, leaving and deleting a group (the group's details). */
  manageGroups: boolean;
  /**
   * The backend writes trino-gui-debug.log on this device, and Settings >
   * Avanzado says so. After T3 (W7) only a debug build does: `tauri dev`,
   * which runs with Vite's dev server. The exe writes none, and every build
   * removes the trino-gui.log of before T3 (B2).
   */
  diagnosticLog: boolean;
  /** Invitation links (INV, supplement §8): built now, turned on with Tor. */
  inviteLinks: boolean;
  /** Message requests from people who are not contacts yet (R6b): with Tor. */
  messageRequests: boolean;
  /** @names: find, register and remember them (K14): with Tor. */
  names: boolean;
}

export const capabilities: Readonly<Capabilities> = Object.freeze({
  profileSync: true,
  callLog: true,
  relayStatus: true,
  sendAck: true,
  deleteForMe: true,
  totp: true,
  changePassphrase: true,
  emergencyKey: true,
  groupMembers: true,
  manageGroups: true,
  diagnosticLog: import.meta.env.DEV,
  inviteLinks: false,
  messageRequests: false,
  names: false,
});
