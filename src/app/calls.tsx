/**
 * The calls of the chats (plan §4, I5 and I6; plan-cambios-11oct §7): W6's
 * call controller over call.ts, and its screens over the shell.
 *
 * - Who a call is with comes from the shell's contacts: the name given
 *   here, the photo, the identity digest the SAS v2 needs (K7), and whether
 *   the contact is verified, which only the mark of a call or a QR with the
 *   fingerprint it still has says (`prefs.isVerified`).
 * - "Coinciden" stores the mark of a call (`prefs.setVerified`), and a
 *   "Coinciden" undone, by a new DTLS fingerprint or a later "No
 *   coinciden", clears it unless the contact was verified before the call:
 *   the controller decides when (docs/sas-v2.md).
 * - The question of calling directly when TURN fails belongs to call.ts and
 *   the controller: nothing here reads or writes a preference on that path,
 *   so it is asked on every call (docs/llamadas-turn.md).
 * - The call log (K13) with the chat's timer, when the shell can show it;
 *   the ringtone, its volume and the notice of a call that rings while
 *   Trino is behind other windows, from Settings.
 *
 * The shell (W2's ShellScreen, src/app/MainScreen.tsx) mounts `slot.bar`
 * above both panes and `slot.layer` over them, below the title bar, and
 * makes all of itself but the layer inert while `slot.covering`. App ends a
 * call through `gate` before it locks, closes the window or quits.
 */
import { useMemo } from 'react';
import { api, notify, onCallSignal, type CallEventWire, type CallLogWire, type CallSignalEvent, type NodeInfo } from '../lib/api';
import { prefs as devicePrefs, type Prefs } from '../lib/prefs';
import { callSlot, useCallController, type CallController, type CallSounds } from '../screens/call';
import type { CallSlot } from '../screens/types';
import { capabilities } from './capabilities';

/** What the calls ask of the backend beside call.ts. */
export interface CallsBackend {
  notify(title: string, body: string): Promise<void>;
  /** K13: the call, as a line of its chat. */
  recordCall(peer: string, call: CallEventWire, startedAt: number): Promise<CallLogWire>;
  onCallSignal(cb: (event: CallSignalEvent) => void): Promise<() => void>;
}

/** The real backend: src/lib/api.ts. */
export const callsBackend: CallsBackend = { notify, recordCall: api.recordCall, onCallSignal };

export interface CallsOptions {
  /** The shell's contacts: who a call is with, as it has them now. */
  contacts: readonly NodeInfo[];
  /** Your identity digest (K7), for the call's SAS v2; null until your profile is read. */
  myIdentityDigest: string | null;
  /** Trino is in front; read when a call rings, which is notified otherwise. */
  isWindowVisible(): boolean;
  /**
   * Record each call in its chat (K13). By default what this build's backend
   * can do; a shell that cannot show a call in the chat says false, or the
   * end card would say "Queda registrada en el chat." of a chat without it.
   */
  callLog?: boolean;
  /** The backend, unless a test brings its own. */
  api?: CallsBackend;
  /** The preferences of this device, unless a test brings its own. */
  prefs?: Prefs;
  /** The call's tones, unless a test brings its own (jsdom has no Web Audio). */
  sounds?: CallSounds;
}

/** What App asks of the calls before it locks, closes the window or quits. */
export type CallGate = Pick<CallController, 'confirmEnd'>;

export interface Calls {
  /** For the shell: the bar above both panes, the layer over them, and whether it covers them. */
  slot: CallSlot;
  /** For App: during a call, locking and closing ask first and hang up on yes; quitting hangs up. */
  gate: CallGate;
}

export function useCalls(options: CallsOptions): Calls {
  const backend = options.api ?? callsBackend;
  const prefs = options.prefs ?? devicePrefs;
  const nodeOf = (handle: string) => options.contacts.find(contact => contact.handle === handle);
  // The controller reads these when it needs them, from its latest render.
  const controller = useCallController({
    api: { notify: backend.notify, recordCall: backend.recordCall },
    events: { onCallSignal: backend.onCallSignal },
    peer: handle => {
      const node = nodeOf(handle);
      if (!node) return null;
      return {
        name: node.handle,
        avatar: node.avatar ?? null,
        verified: prefs.isVerified(node.handle, node.fingerprint),
        identityDigest: node.identity_digest ?? null,
        blocked: node.blocked === true,
      };
    },
    me: { identityDigest: options.myIdentityDigest },
    isWindowVisible: options.isWindowVisible,
    onVerified: handle => {
      const node = nodeOf(handle);
      if (node) prefs.setVerified(node.handle, node.fingerprint);
    },
    onVerificationRevoked: handle => {
      prefs.clearVerified(handle);
    },
    ttlFor: handle => prefs.getTtl(handle),
    capabilities: { callLog: options.callLog ?? capabilities.callLog },
    alerts: {
      ringtone: () => ({ tone: prefs.getRingtone(), volume: prefs.getRingVolume() }),
      notifyWhenHidden: () => prefs.getCallNotifyHidden(),
      notifyWithName: () => prefs.getNotifPreview() !== 'none',
    },
    ...(options.sounds && { sounds: options.sounds }),
  });
  const gate = useMemo<CallGate>(() => ({ confirmEnd: controller.confirmEnd }), [controller.confirmEnd]);
  return { slot: callSlot(controller), gate };
}
