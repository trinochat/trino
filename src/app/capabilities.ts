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
  inviteLinks: false,
  messageRequests: false,
  names: false,
});
