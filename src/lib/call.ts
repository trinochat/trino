// call.ts — 1:1 voice/video calls over WebRTC (professional rewrite).
//
// Media (audio/video) is encrypted by WebRTC's DTLS-SRTP. Signaling rides
// trino's E2E channel via send_call_signal.
//
// Connection mode (docs/llamadas-turn.md): a call is `protected` by default,
// relayed through Cloudflare TURN only (`get_turn_servers`, relay transport,
// relay candidates only), so the contact never sees our IP. When TURN cannot
// be had, the user is asked before a `direct` call (STUN from
// `get_call_config`); there is never a silent fallback, and a "no" cancels.
// A protected call renews its TURN credentials before they expire, and before
// an ICE restart; a failed renewal never turns it into a direct call.
//
// Design notes:
// - Explicit offer/answer for call setup (predictable ringing UX), plus
//   glare-safe renegotiation for mid-call changes (e.g. turning the camera on
//   during a voice call).
// - Address privacy (see ice-privacy.ts): the caller's offer carries no
//   candidates and its candidates are held until the callee answers, so no
//   address leaves before the other person accepts. Every SDP and candidate
//   that is sent is filtered: private/LAN addresses never leave the device.
// - Errors are surfaced through onError instead of being swallowed.
// - getUserMedia degrades gracefully: a video call with no camera falls back to
//   audio rather than failing silently.
// - Connection drops are handled leniently — a transient `disconnected` gets a
//   grace period before the call is torn down; only `failed`/`closed` end it.
// - Ring/answer timeouts prevent calls from hanging forever.
// - No open microphone: every async step checks that its call is still the
//   current one and releases what it acquired otherwise; the backend is told
//   while media is held, so closing the window or quitting hangs up first.

import { api } from './api';
import {
  RecentIds,
  decideIncomingOffer,
  holdsMedia,
  isBusy,
  sanitizeIceServers,
  signalBelongsToCall,
  type CallState,
  type IceServerConfig,
} from './call-rules';
import {
  DEV_ALLOW_LAN_KEY,
  OutgoingCandidates,
  callPolicy,
  relayServers,
  rtcConfiguration,
  scrubSdp,
  type CandidatePolicy,
  type ConnectionMode,
} from './ice-privacy';

export type { CallState } from './call-rules';
export type { ConnectionMode } from './ice-privacy';

/** TURN failed: may this call go direct, revealing our IP to `peer`? */
export interface DirectConsentRequest {
  peer: string;
  outgoing: boolean; // we are placing the call (false: answering it)
}

export interface MediaState {
  muted: boolean;
  cameraOn: boolean;
  hasVideo: boolean; // whether this call currently carries a video track
}

export type CallErrorCode =
  | 'signal'
  | 'permission'
  | 'microphone'
  | 'camera'
  | 'no-answer'
  | 'connection';

/**
 * What the SAS v2 of a call is made from (docs/sas-v2.md), as `parseFp`
 * gives the fingerprints: 64 lowercase hex digits, without colons.
 */
export interface SasInputs {
  callId: string;
  localDtls: string;
  remoteDtls: string;
}

export interface CallCallbacks {
  // `callId` is the id of the call the state belongs to, the final 'ended'
  // or 'rejected' included; null only when there is no call.
  onState: (s: CallState, info: { peer: string | null; video: boolean; callId: string | null }) => void;
  onLocalStream: (s: MediaStream | null) => void;
  onRemoteStream: (s: MediaStream | null) => void;
  // Short Authentication String (Telegram-style emoji code) from the DTLS
  // fingerprints. Identical on both peers when there's no man-in-the-middle.
  onSas: (emojis: string) => void;
  onError: (code: CallErrorCode) => void;
  // Current mute / camera state so the UI can reflect the real track status.
  onMedia: (m: MediaState) => void;
  // How the current call travels; null when there is none.
  onConnectionMode: (mode: ConnectionMode | null) => void;
  // TURN failed: ask whether to go direct (null closes the question). Answer
  // with answerDirectConsent(); anything but an explicit yes cancels.
  onDirectConsent: (request: DirectConsentRequest | null) => void;
  // The inputs of the call's SAS v2, each time a description is applied:
  // after the answer, and again on every renegotiation. The redesigned
  // screen derives the symbols from them and ends the call if the remote
  // fingerprint changes (docs/sas-v2.md, "The DTLS fingerprint rule").
  onSasInputs?: (inputs: SasInputs) => void;
}

interface Signal {
  t: 'offer' | 'answer' | 'ice' | 'bye' | 'reject';
  callId: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  video?: boolean;
  renegotiate?: boolean; // offer/answer for an in-call change, not initial setup
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCallId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function validCandidate(value: unknown): value is RTCIceCandidateInit {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.some(
      key => !['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key),
    )
  ) {
    return false;
  }
  if (
    typeof value.candidate !== 'string' ||
    value.candidate.length === 0 ||
    value.candidate.length > 4096
  ) {
    return false;
  }
  if (
    value.sdpMid !== undefined &&
    value.sdpMid !== null &&
    (typeof value.sdpMid !== 'string' || value.sdpMid.length > 256)
  ) {
    return false;
  }
  if (
    value.sdpMLineIndex !== undefined &&
    value.sdpMLineIndex !== null &&
    (!Number.isInteger(value.sdpMLineIndex) ||
      (value.sdpMLineIndex as number) < 0 ||
      (value.sdpMLineIndex as number) > 65_535)
  ) {
    return false;
  }
  return !(
    value.usernameFragment !== undefined &&
    value.usernameFragment !== null &&
    (typeof value.usernameFragment !== 'string' || value.usernameFragment.length > 256)
  );
}

function parseSignal(payload: string): Signal | null {
  if (new TextEncoder().encode(payload).byteLength > MAX_SIGNAL_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value) || !validCallId(value.callId)) return null;
  const allowedKeys = ['t', 'callId', 'sdp', 'candidate', 'video', 'renegotiate'];
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) return null;
  if (
    value.video !== undefined && typeof value.video !== 'boolean' ||
    value.renegotiate !== undefined && typeof value.renegotiate !== 'boolean'
  ) {
    return null;
  }

  if (value.t === 'offer' || value.t === 'answer') {
    if (
      typeof value.sdp !== 'string' ||
      value.sdp.length === 0 ||
      value.sdp.length > MAX_SDP_CHARS ||
      !value.sdp.startsWith('v=0') ||
      value.candidate !== undefined
    ) {
      return null;
    }
  } else if (value.t === 'ice') {
    if (!validCandidate(value.candidate) || value.sdp !== undefined) return null;
  } else if (value.t === 'bye' || value.t === 'reject') {
    if (
      value.sdp !== undefined ||
      value.candidate !== undefined ||
      value.video !== undefined ||
      value.renegotiate !== undefined
    ) {
      return null;
    }
  } else {
    return null;
  }

  return value as unknown as Signal;
}

const RING_TIMEOUT_MS = 45_000; // give up if nobody answers
// The callee stops ringing on its own a little after the caller gave up, in
// case the caller's bye never arrives. It sends nothing: an automatic reply
// would tell any contact that this device is online.
const INCOMING_RING_LIMIT_MS = RING_TIMEOUT_MS + 15_000;
const DISCONNECT_GRACE_MS = 12_000; // let ICE try to recover before tearing down
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_SDP_CHARS = 56 * 1024;
const MAX_PENDING_ICE = 128;
// Calls whose bye/reject we saw or sent, so a late copy of their offer (relays
// deliver out of order, and again after a reconnect) never rings.
const ENDED_CALLS_REMEMBERED = 64;
// Before releasing the camera, send a few black frames so the other side is
// not left looking at a frozen picture of us.
const CAMERA_OFF_BLACK_FRAMES_MS = 200;
const HANGUP_BYE_TIMEOUT_MS = 1_200;
// Cloudflare drops a relay shortly after its credentials expire: a protected
// call fetches new ones this long before (docs/llamadas-turn.md).
const RELAY_REFRESH_MARGIN_S = 10 * 60;
const RELAY_RETRY_MS = 60_000; // also the shortest wait before a refresh
const RELAY_REFRESH_ATTEMPTS = 3; // failures in a row before giving up

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 24, max: 30 },
};

// Direct-mode STUN servers come only from the backend (`get_call_config`) and
// are loaded only after the user agreed to a direct call; there is no fallback
// list here. An empty list is valid and means "no STUN".
let iceServers: IceServerConfig[] | null = null;
let iceServersLoading: Promise<IceServerConfig[]> | null = null;

export function configureIceServers(servers: unknown): void {
  iceServers = sanitizeIceServers(servers);
}

function loadDirectIceServers(): Promise<IceServerConfig[]> {
  if (iceServers) return Promise.resolve(iceServers);
  iceServersLoading ??= api
    .getCallConfig()
    .then(config => {
      configureIceServers(config.ice_servers);
      return iceServers ?? [];
    })
    .catch(error => {
      // Without a valid configuration, calls use no STUN rather than a
      // server nobody configured.
      console.error('call configuration failed', error);
      iceServersLoading = null;
      return [];
    });
  return iceServersLoading;
}

// Hacker-themed emoji set for the Short Authentication String (MITM tripwire).
const SAS_EMOJIS = [
  '🐛', '🔑', '🔒', '🛰', '🦠', '💾', '🖥', '📡', '🧬', '⚡', '🔥', '🌐', '🧠', '👾', '🛡', '🗝',
  '📟', '🔌', '🧩', '🎛', '🚀', '⭐', '🌙', '🎧', '📀', '🧿', '🔭', '🕹', '💿', '📼', '🧫', '🔬',
  '🦅', '🐉', '🌵', '🍄', '🎯', '🧨', '💣', '🕵', '🔦', '📎', '🧷', '⛓', '🪝', '🧲', '⚙', '🪫',
  '🛸', '🌀', '❄', '🌊', '🎲', '♟', '🧭', '⏳', '📮', '🔗', '💊', '🩸', '🦂', '🕷', '🐙', '🦑',
];

function parseFp(sdp?: string | null): string | null {
  if (!sdp) return null;
  const m = sdp.match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/);
  return m ? m[1].replace(/:/g, '').toLowerCase() : null;
}

async function computeSas(): Promise<void> {
  const p = pc;
  if (!p || !cbs) return;
  const a = parseFp(p.localDescription?.sdp);
  const b = parseFp(p.remoteDescription?.sdp);
  if (!a || !b) return;
  if (callId) cbs.onSasInputs?.({ callId, localDtls: a, remoteDtls: b });
  if (pc !== p) return; // the call ended (onSasInputs may end it)
  const joined = [a, b].sort().join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  if (pc !== p || !cbs) return; // ended meanwhile: its emojis would outlive it
  const bytes = new Uint8Array(digest);
  const emojis = Array.from({ length: 5 }, (_, i) => SAS_EMOJIS[bytes[i]! % SAS_EMOJIS.length]);
  cbs.onSas(emojis.join(' '));
}

// ── module state ────────────────────────────────────────────────────────────
let state: CallState = 'idle';
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let peer: string | null = null;
let callId: string | null = null;
let video = false; // whether this call negotiated a video track
let polite = false; // callee is polite; used for glare-free renegotiation
let outgoing = false; // we placed the current call
let answered = false; // the callee's answer to our offer has been applied
// Our offer or answer may have reached the peer: only then does hanging up
// owe them a bye. Before that, a bye would only tell them we are online.
let signalled = false;
let makingOffer = false;
let pendingOffer: { from: string; sig: Signal } | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let cbs: CallCallbacks | null = null;
// Only allow onnegotiationneeded to fire renegotiation offers AFTER the initial
// offer/answer is done. Otherwise the automatic negotiation collides with the
// manual createOffer/createAnswer during setup and corrupts the SDP.
let renegotiationReady = false;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
let relayTimer: ReturnType<typeof setTimeout> | null = null;
let relayFailures = 0;
let iceRestartAttempted = false;
let iceRestarting = false;
// Bumped by end(). An async step (getUserMedia, createOffer…) that resumes
// under an older generation belongs to a call that is over and must release
// whatever it acquired instead of reviving it.
let generation = 0;
let policy: CandidatePolicy = 'public';
let mode: ConnectionMode | null = null;
// Resolves the open "call directly?" question, if any.
let consentResolve: ((allow: boolean) => void) | null = null;
const candidates = new OutgoingCandidates('public');
const endedCalls = new RecentIds(ENDED_CALLS_REMEMBERED);
// Mirror of holdsMedia(state) in the backend (set_call_active).
let mediaFlag = false;
let mediaFlagHeld = false; // keep it set until a pending bye has gone out
let mediaFlagSync: Promise<void> = Promise.resolve();
let cameraBusy = false; // a camera on/off switch is in progress

export function initCall(callbacks: CallCallbacks): void {
  cbs = callbacks;
}

/** A call is ringing or in progress. */
export function isCallBusy(): boolean {
  return isBusy(state);
}

/** The current call may hold the microphone or camera. */
export function callHoldsMedia(): boolean {
  return holdsMedia(state);
}

function rid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function callKey(from: string, id: string): string {
  return `${from}\n${id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function devSwitch(): string | null {
  try {
    return localStorage.getItem(DEV_ALLOW_LAN_KEY);
  } catch {
    return null;
  }
}

function setMode(next: ConnectionMode | null): void {
  if (mode === next) return;
  mode = next;
  cbs?.onConnectionMode(next);
}

function settleConsent(allow: boolean): void {
  const resolve = consentResolve;
  if (!resolve) return;
  consentResolve = null;
  cbs?.onDirectConsent(null);
  resolve(allow);
}

function askDirectConsent(): Promise<boolean> {
  settleConsent(false);
  const ask = cbs?.onDirectConsent;
  if (!ask || !peer) return Promise.resolve(false);
  const request: DirectConsentRequest = { peer, outgoing };
  return new Promise(resolve => {
    consentResolve = resolve;
    ask(request);
  });
}

/** The user's answer to "call directly?". Anything but an explicit yes cancels. */
export function answerDirectConsent(allow: boolean): void {
  settleConsent(allow === true);
}

interface Route {
  mode: ConnectionMode;
  servers: IceServerConfig[];
  expiresAt?: number; // protected: when the TURN credentials expire (unix s)
}

/**
 * TURN first, asked afresh for every call: the backend caches the credentials
 * and knows when they expire. Without TURN, ask before going direct. Null:
 * do not place or answer this call (declined, or the call ended meanwhile).
 */
async function resolveRoute(my: number): Promise<Route | null> {
  let relays: IceServerConfig[] = [];
  let expiresAt: number | undefined;
  try {
    const turn = await api.getTurnServers();
    relays = relayServers(turn.ice_servers);
    expiresAt = turn.expires_at;
  } catch (error) {
    console.error('TURN credentials unavailable', error);
  }
  if (my !== generation) return null;
  if (relays.length > 0) return { mode: 'protected', servers: relays, expiresAt };
  if (!(await askDirectConsent()) || my !== generation) return null;
  const servers = await loadDirectIceServers();
  return my === generation ? { mode: 'direct', servers } : null;
}

/** Adopt the call's route: its candidate policy (gate in `hold`) and its mode. */
function adoptRoute(route: Route): void {
  policy = callPolicy(route.mode, devSwitch());
  candidates.reset(policy);
  setMode(route.mode);
}

/** Renew the TURN credentials of `p` before they expire (protected calls only). */
function scheduleRelayRefresh(p: RTCPeerConnection, expiresAt: number | undefined): void {
  clearRelayTimer();
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;
  const due = (expiresAt - RELAY_REFRESH_MARGIN_S) * 1000 - Date.now();
  relayTimer = setTimeout(() => {
    relayTimer = null;
    void refreshRelays(p);
  }, Math.max(RELAY_RETRY_MS, due));
}

function clearRelayTimer(): void {
  if (relayTimer) clearTimeout(relayTimer);
  relayTimer = null;
}

/**
 * Fresh TURN credentials for the protected call on `p`, applied with
 * setConfiguration (same policies, so it is allowed mid-call). A failure is
 * retried a few times and never makes the call go direct: if the relay drops,
 * the call ends like any broken one.
 */
async function refreshRelays(p: RTCPeerConnection): Promise<void> {
  const my = generation;
  let relays: IceServerConfig[] = [];
  let expiresAt: number | undefined;
  try {
    const turn = await api.getTurnServers();
    relays = relayServers(turn.ice_servers);
    expiresAt = turn.expires_at;
  } catch (error) {
    console.error('TURN refresh failed', error);
  }
  if (my !== generation || pc !== p) return;
  if (relays.length > 0) {
    try {
      p.setConfiguration(rtcConfiguration('protected', relays));
      relayFailures = 0;
      scheduleRelayRefresh(p, expiresAt);
      return;
    } catch (error) {
      console.error('TURN refresh not applied', error);
    }
  }
  relayFailures++;
  if (relayFailures >= RELAY_REFRESH_ATTEMPTS) return;
  clearRelayTimer();
  relayTimer = setTimeout(() => {
    relayTimer = null;
    void refreshRelays(p);
  }, RELAY_RETRY_MS);
}

function syncMediaFlag(): void {
  const active = holdsMedia(state) || (mediaFlag && mediaFlagHeld);
  if (active === mediaFlag) return;
  mediaFlag = active;
  mediaFlagSync = mediaFlagSync.then(() => api.setCallActive(active)).catch(() => {});
}

function setState(next: CallState): void {
  state = next;
  syncMediaFlag();
  cbs?.onState(next, { peer, video, callId });
}

async function send(to: string, s: Signal): Promise<boolean> {
  const payload = JSON.stringify(s);
  if (new TextEncoder().encode(payload).byteLength > MAX_SIGNAL_BYTES) {
    cbs?.onError('signal');
    return false;
  }
  try {
    await api.sendCallSignal(to, payload);
    return true;
  } catch (e) {
    console.error('call signal send failed', e);
    cbs?.onError('signal');
    return false;
  }
}

function sendCandidates(to: string, id: string, list: RTCIceCandidateInit[]): void {
  for (const candidate of list) void send(to, { t: 'ice', callId: id, candidate });
}

function clearTimers(): void {
  if (ringTimer) clearTimeout(ringTimer);
  if (disconnectTimer) clearTimeout(disconnectTimer);
  ringTimer = null;
  disconnectTimer = null;
  clearRelayTimer();
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach(t => t.stop());
}

function reportMedia(): void {
  if (!cbs) return;
  const audio = localStream?.getAudioTracks()[0];
  const vid = localStream?.getVideoTracks()[0];
  cbs.onMedia({
    muted: audio ? !audio.enabled : false,
    cameraOn: vid ? vid.enabled : false,
    hasVideo: !!vid,
  });
}

// Request mic (+ camera). If the camera is unavailable but was requested, fall
// back to audio-only so a call can still happen instead of failing silently.
async function getMedia(withVideo: boolean): Promise<{ stream: MediaStream; video: boolean }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: withVideo ? VIDEO_CONSTRAINTS : false,
    });
    return { stream, video: withVideo };
  } catch (e) {
    if (!withVideo) throw e;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: false,
    });
    return { stream, video: false };
  }
}

function mediaErrorCode(error: unknown, device: 'microphone' | 'camera'): CallErrorCode {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  ) {
    return 'permission';
  }
  return device;
}

function makePc(remote: string, id: string, config: RTCConfiguration): RTCPeerConnection {
  const p = new RTCPeerConnection(config);

  p.onicecandidate = e => {
    if (pc !== p || !e.candidate) return;
    sendCandidates(remote, id, candidates.offer(e.candidate.toJSON()));
  };

  p.ontrack = e => {
    if (pc !== p) return;
    const stream = e.streams[0] ?? null;
    cbs?.onRemoteStream(stream);
    if (e.track.kind === 'video') {
      video = true;
      setState(p.connectionState === 'connected' ? 'connected' : 'connecting');
    }
  };

  // Glare-safe renegotiation: when tracks change (e.g. camera turned on), emit a
  // fresh offer. Only fires after the initial exchange thanks to makingOffer.
  p.onnegotiationneeded = async () => {
    // Ignore the automatic negotiation triggered by the initial addTrack — the
    // first offer/answer is created manually. Only renegotiate (e.g. camera
    // turned on) once the call is established.
    if (
      pc !== p ||
      !renegotiationReady ||
      !callId ||
      iceRestarting ||
      makingOffer ||
      p.signalingState !== 'stable'
    ) {
      return;
    }
    try {
      makingOffer = true;
      await p.setLocalDescription();
      if (pc !== p) return;
      await send(remote, {
        t: 'offer',
        callId: id,
        sdp: scrubSdp(p.localDescription?.sdp ?? '', policy),
        video,
        renegotiate: true,
      });
    } catch (err) {
      console.error('renegotiation failed', err);
    } finally {
      makingOffer = false;
    }
  };

  p.onconnectionstatechange = () => {
    if (pc !== p) return;
    const st = p.connectionState;
    if (st === 'connected') {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      clearRing();
      renegotiationReady = true; // now safe to renegotiate (e.g. add video)
      iceRestarting = false;
      setState('connected');
    } else if (st === 'disconnected') {
      // Transient — ICE may recover. If it does not, attempt one ICE restart.
      if (!disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null;
          void recoverConnection(remote, id, p);
        }, DISCONNECT_GRACE_MS);
      }
    } else if (st === 'failed' || st === 'closed') {
      if (st === 'failed') void recoverConnection(remote, id, p);
      else end();
    }
  };

  return p;
}

async function recoverConnection(
  remote: string,
  id: string,
  connection: RTCPeerConnection,
): Promise<void> {
  if (pc !== connection || iceRestarting) return;
  if (iceRestartAttempted) {
    cbs?.onError('connection');
    end();
    return;
  }

  iceRestartAttempted = true;
  iceRestarting = true;
  setState('connecting');
  try {
    makingOffer = true;
    // The restart allocates new relays: with credentials that will last.
    if (mode === 'protected') await refreshRelays(connection);
    if (pc !== connection) return;
    candidates.embed(); // the restart offer below carries the new candidates
    connection.restartIce();
    const offer = await connection.createOffer({ iceRestart: true });
    await connection.setLocalDescription(offer);
    await waitIceComplete(connection, 5_000);
    if (pc !== connection) return;
    const sdp = scrubSdp(connection.localDescription?.sdp ?? offer.sdp ?? '', policy);
    candidates.release(); // anything gathered from now on is trickled
    const sent = await send(remote, {
      t: 'offer',
      callId: id,
      sdp,
      video,
      renegotiate: true,
    });
    if (pc !== connection) return;
    if (!sent) {
      end();
      return;
    }
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      if (pc === connection && connection.connectionState !== 'connected') {
        cbs?.onError('connection');
        end();
      }
    }, DISCONNECT_GRACE_MS);
  } catch (error) {
    if (pc !== connection) return;
    console.error('ICE restart failed', error);
    cbs?.onError('connection');
    end();
  } finally {
    makingOffer = false;
    iceRestarting = false;
  }
}

function clearRing(): void {
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = null;
}

// Wait until ICE gathering finishes so an answer SDP already carries all
// candidates. Trickle-ICE over the slow Nostr signaling channel loses/delays
// candidates; sending one complete SDP is far more reliable. Capped so a stuck
// TURN probe can't hang the call. Only used once the other side has accepted:
// the caller's first offer never waits (and never carries candidates).
function waitIceComplete(p: RTCPeerConnection, timeoutMs = 3500): Promise<void> {
  if (p.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      p.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (p.iceGatheringState === 'complete') finish();
    };
    p.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, timeoutMs);
  });
}

async function flushIce(): Promise<void> {
  if (!pc || !pc.remoteDescription) return;
  const queued = pendingIce;
  pendingIce = [];
  for (const c of queued) {
    try {
      await pc.addIceCandidate(c);
    } catch {
      /* ignore stale candidate */
    }
  }
}

// ── outgoing call ───────────────────────────────────────────────────────────
export async function startCall(remote: string, withVideo: boolean): Promise<void> {
  api.devLog(`startCall video=${withVideo} state=${state}`);
  // `starting` makes a double click a no-op: the second click must not open a
  // second microphone stream that nobody would ever stop.
  if (isBusy(state)) return;
  const my = generation;
  const id = rid();
  peer = remote;
  callId = id;
  video = withVideo;
  polite = false; // caller is impolite (wins glare)
  outgoing = true;
  answered = false;
  signalled = false;
  setState('starting');

  // Before the microphone opens: a "no" to a direct call must leave nothing on.
  const route = await resolveRoute(my);
  if (!route) {
    if (my === generation) end();
    return;
  }
  adoptRoute(route); // hold: nothing leaves until the callee answers
  let media: { stream: MediaStream; video: boolean };
  try {
    media = await getMedia(withVideo);
  } catch (error) {
    if (my !== generation) return;
    api.devLog('startCall getMedia FAILED');
    cbs?.onError(mediaErrorCode(error, 'microphone'));
    end();
    return;
  }
  if (my !== generation) {
    stopStream(media.stream); // hung up (or locked) while the prompt was open
    return;
  }
  localStream = media.stream;
  video = media.video;
  cbs?.onLocalStream(localStream);
  reportMedia();
  try {
    const p = makePc(remote, id, rtcConfiguration(route.mode, route.servers));
    pc = p;
    if (route.mode === 'protected') scheduleRelayRefresh(p, route.expiresAt);
    localStream.getTracks().forEach(t => p.addTrack(t, localStream!));
    const offer = await p.createOffer();
    if (pc !== p) return;
    await p.setLocalDescription(offer);
    if (pc !== p) return;
    // Sent at once, without waiting for ICE gathering and without a single
    // candidate: our addresses are released only when the callee answers.
    signalled = true;
    const sent = await send(remote, {
      t: 'offer',
      callId: id,
      sdp: scrubSdp(offer.sdp ?? '', 'withhold'),
      video,
    });
    if (pc !== p) return;
    if (!sent) {
      end();
      return;
    }
    api.devLog('offer sent');
    if (state === 'starting') setState('ringing-out');
    armRingTimeout();
  } catch (error) {
    if (my !== generation) return;
    console.error('outgoing call setup failed', error);
    cbs?.onError('connection');
    end();
  }
}

function armRingTimeout(): void {
  clearRing();
  ringTimer = setTimeout(() => {
    cbs?.onError('no-answer');
    hangup();
  }, RING_TIMEOUT_MS);
}

// ── answering ───────────────────────────────────────────────────────────────
/**
 * Answer the ringing call. `{ video: false }` answers a video call with the
 * microphone only ("Contestar solo con audio"): the caller's video still
 * arrives, and the camera can be turned on later. It never adds video to a
 * voice call.
 */
export async function acceptIncoming(opts?: { video?: boolean }): Promise<void> {
  if (!pendingOffer || state !== 'ringing-in') return;
  const { from, sig } = pendingOffer;
  pendingOffer = null;
  await answerOffer(from, sig, opts?.video !== false);
}

async function answerOffer(from: string, sig: Signal, withVideo = true): Promise<void> {
  clearRing();
  const my = generation;
  const id = sig.callId;
  peer = from;
  callId = id;
  video = !!sig.video && withVideo;
  polite = true; // callee is polite
  outgoing = false;
  answered = false;
  signalled = false;
  setState('connecting');

  const route = await resolveRoute(my);
  if (!route) {
    if (my === generation) {
      // No protection and no consent to answer without it: decline.
      void send(from, { t: 'reject', callId: id });
      end();
    }
    return;
  }
  adoptRoute(route);
  candidates.embed(); // the answer carries our candidates; later ones trickle
  let media: { stream: MediaStream; video: boolean };
  try {
    media = await getMedia(video);
  } catch (error) {
    if (my !== generation) return;
    cbs?.onError(mediaErrorCode(error, 'microphone'));
    void send(from, { t: 'reject', callId: id });
    end();
    return;
  }
  if (my !== generation) {
    stopStream(media.stream);
    return;
  }
  localStream = media.stream;
  video = media.video;
  cbs?.onLocalStream(localStream);
  reportMedia();
  try {
    const p = makePc(from, id, rtcConfiguration(route.mode, route.servers));
    pc = p;
    if (route.mode === 'protected') scheduleRelayRefresh(p, route.expiresAt);
    await p.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
    if (pc !== p) return;
    localStream.getTracks().forEach(t => p.addTrack(t, localStream!));
    await flushIce();
    const answer = await p.createAnswer();
    if (pc !== p) return;
    await p.setLocalDescription(answer);
    await waitIceComplete(p); // answer SDP carries our (filtered) candidates
    if (pc !== p) return;
    const sdp = scrubSdp(p.localDescription?.sdp ?? answer.sdp ?? '', policy);
    signalled = true;
    sendCandidates(from, id, candidates.release());
    const sent = await send(from, { t: 'answer', callId: id, sdp });
    if (pc !== p) return;
    if (!sent) {
      end();
      return;
    }
    api.devLog(`answer sent, iceState=${p.iceGatheringState}`);
    void computeSas();
  } catch (error) {
    if (my !== generation) return;
    console.error('incoming call setup failed', error);
    cbs?.onError('connection');
    void send(from, { t: 'reject', callId: id });
    end();
  }
}

export function rejectIncoming(): void {
  if (state !== 'ringing-in') return; // e.g. a double click on "reject"
  if (pendingOffer) {
    void send(pendingOffer.from, { t: 'reject', callId: pendingOffer.sig.callId });
  }
  end();
}

export function hangup(): void {
  // A call whose offer or answer never went out ends silently: there is
  // nothing to end on the other side, and a bye would only tell them that
  // this device is online (an incoming call not yet accepted, or one still
  // fetching TURN credentials).
  if (peer && callId && signalled) void send(peer, { t: 'bye', callId });
  end();
}

/**
 * Hang up, then wait (bounded) until the bye has been handed to the backend.
 * Media is released immediately; the backend's "call active" flag is cleared
 * only after the bye, so quitting from the tray cannot cut it off.
 */
export async function hangupAndWait(timeoutMs = HANGUP_BYE_TIMEOUT_MS): Promise<void> {
  const to = peer;
  const id = callId;
  const sendBye = !!to && !!id && signalled; // see hangup()
  mediaFlagHeld = sendBye;
  teardownCall();
  try {
    if (sendBye) await Promise.race([send(to!, { t: 'bye', callId: id! }), sleep(timeoutMs)]);
  } finally {
    mediaFlagHeld = false;
    syncMediaFlag();
  }
  await mediaFlagSync;
}

/**
 * Release everything without signalling: stop every track (microphone and
 * camera), close the connection and reset the state. Used when the main view
 * goes away (lock, unmount); safe to call at any time.
 */
export function teardownCall(): void {
  if (isBusy(state) || pc || localStream || pendingOffer) end();
  else generation++; // still cancel any async step in flight
}

// ── incoming signals ────────────────────────────────────────────────────────
export function handleSignal(from: string, payload: string): void {
  const s = parseSignal(payload);
  if (!s) {
    console.warn('[CALL] invalid signal payload');
    return;
  }
  api.devLog(`recv ${s.t} reneg=${!!s.renegotiate} state=${state} current=${s.callId === callId}`);

  if (s.t === 'offer' && !s.renegotiate) {
    handleNewOffer(from, s);
    return;
  }

  // Everything else belongs to the current call, from its peer only.
  if (!signalBelongsToCall({ callId, peer }, from, s.callId)) {
    // A bye/reject that overtook its offer: remember it so the offer, when it
    // finally arrives, does not ring.
    if (s.t === 'bye' || s.t === 'reject') endedCalls.add(callKey(from, s.callId));
    return;
  }

  if (s.t === 'offer' && s.renegotiate && pc) {
    void handleRenegotiation(from, s);
  } else if (s.t === 'answer' && pc) {
    handleAnswer(from, s, pc);
  } else if (s.t === 'ice' && s.candidate) {
    if (pc && pc.remoteDescription) pc.addIceCandidate(s.candidate).catch(() => {});
    else if (pendingIce.length < MAX_PENDING_ICE) pendingIce.push(s.candidate);
  } else if (s.t === 'bye' || s.t === 'reject') {
    // A reject on our outgoing call shows the "rejected" screen (close/retry);
    // a bye (peer hung up) just ends.
    end(s.t === 'reject' && outgoing ? 'rejected' : 'ended');
  }
}

function handleNewOffer(from: string, s: Signal): void {
  const decision = decideIncomingOffer({
    state,
    peer,
    callId,
    outgoing: outgoing && !answered,
    connected: pc?.connectionState === 'connected',
    from,
    offerCallId: s.callId,
    alreadyEnded: endedCalls.has(callKey(from, s.callId)),
  });
  api.devLog(`new offer -> ${decision}`);
  switch (decision) {
    case 'ignore':
      return;
    case 'ring':
      ring(from, s);
      return;
    case 'busy':
      endedCalls.add(callKey(from, s.callId));
      void send(from, { t: 'reject', callId: s.callId });
      return;
    case 'replace':
      // They hung up and called again (or their bye got lost): drop the stale
      // call and ring for the new one instead of declining it.
      if (holdsMedia(state)) hangup();
      else end();
      ring(from, s);
      return;
    case 'glare-keep-ours':
      // We both called: ours wins. They will hang up theirs and accept ours.
      endedCalls.add(callKey(from, s.callId));
      return;
    case 'glare-take-theirs':
      // We both called: theirs wins. We both wanted to talk, so hang up ours
      // and accept theirs without ringing.
      hangup();
      void answerOffer(from, s);
      return;
  }
}

function ring(from: string, s: Signal): void {
  pendingOffer = { from, sig: s };
  peer = from;
  callId = s.callId;
  video = !!s.video;
  outgoing = false;
  answered = false;
  signalled = false;
  api.devLog(`-> ringing-in video=${video}`);
  setState('ringing-in');
  clearRing();
  ringTimer = setTimeout(() => {
    if (state === 'ringing-in' && callId === s.callId) end();
  }, INCOMING_RING_LIMIT_MS);
}

function handleAnswer(from: string, s: Signal, p: RTCPeerConnection): void {
  // Only an answer to an offer we are waiting on; a duplicate is ignored.
  if (p.signalingState !== 'have-local-offer') return;
  const initial = !s.renegotiate && !answered;
  p.setRemoteDescription({ type: 'answer', sdp: s.sdp })
    .then(async () => {
      if (pc !== p) return;
      if (initial) {
        // The callee accepted: now, and only now, our addresses may go out.
        answered = true;
        sendCandidates(from, s.callId, candidates.release());
      }
      await flushIce();
      await computeSas();
    })
    .catch(err => {
      if (pc !== p) return;
      console.error('setRemoteDescription(answer) failed', err);
      cbs?.onError('connection');
      end();
    });
}

// Perfect-negotiation collision handling for mid-call renegotiation.
async function handleRenegotiation(from: string, s: Signal): Promise<void> {
  const p = pc;
  if (!p) return;
  const collision = makingOffer || p.signalingState !== 'stable';
  if (!polite && collision) return; // impolite peer ignores the colliding offer
  try {
    candidates.embed(); // an ICE-restart answer carries its new candidates
    await p.setRemoteDescription({ type: 'offer', sdp: s.sdp });
    if (pc !== p) return;
    void computeSas(); // the offer may carry another fingerprint (onSasInputs)
    if (pc !== p) return;
    await flushIce();
    const answer = await p.createAnswer();
    if (pc !== p) return;
    await p.setLocalDescription(answer);
    await waitIceComplete(p);
    if (pc !== p) return;
    const sdp = scrubSdp(p.localDescription?.sdp ?? answer.sdp ?? '', policy);
    sendCandidates(from, s.callId, candidates.release());
    const sent = await send(from, {
      t: 'answer',
      callId: s.callId,
      sdp,
      renegotiate: true,
    });
    if (!sent && pc === p) end();
  } catch (err) {
    if (pc !== p) return;
    console.error('renegotiation answer failed', err);
    cbs?.onError('connection');
    end();
  }
}

// ── controls ────────────────────────────────────────────────────────────────
export function toggleMute(): boolean {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  reportMedia();
  return !track.enabled; // true = now muted
}

function videoTransceiver(p: RTCPeerConnection): RTCRtpTransceiver | undefined {
  return p
    .getTransceivers()
    .find(
      t =>
        t.receiver.track.kind === 'video' &&
        (t.direction === 'sendrecv' || t.direction === 'sendonly'),
    );
}

// Turn the camera on/off. "Off" stops the track, so the device (and its light)
// is released rather than just muted; the m-line stays, so turning it back on
// is a replaceTrack with no renegotiation. In a voice call, the first "on"
// adds a video track, which renegotiates.
export async function toggleCamera(): Promise<boolean> {
  const p = pc;
  const stream = localStream;
  if (!p || !stream || cameraBusy) return false;
  cameraBusy = true;
  try {
    return await switchCamera(p, stream);
  } finally {
    cameraBusy = false;
  }
}

async function switchCamera(p: RTCPeerConnection, stream: MediaStream): Promise<boolean> {
  const my = generation;
  const current = stream.getVideoTracks()[0];
  if (current) {
    current.enabled = false; // black frames while we detach it
    stream.removeTrack(current);
    reportMedia();
    try {
      await sleep(CAMERA_OFF_BLACK_FRAMES_MS);
      const sender = p.getSenders().find(s => s.track === current);
      if (sender && pc === p) await sender.replaceTrack(null);
    } catch (error) {
      console.error('camera off failed', error);
    } finally {
      current.stop();
    }
    return false;
  }
  let track: MediaStreamTrack | undefined;
  try {
    const cam = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    track = cam.getVideoTracks()[0];
  } catch (error) {
    if (my === generation) cbs?.onError(mediaErrorCode(error, 'camera'));
    return false;
  }
  if (!track) return false;
  if (my !== generation || pc !== p) {
    track.stop(); // the call ended while the camera was opening
    return false;
  }
  try {
    stream.addTrack(track);
    const tx = videoTransceiver(p);
    if (tx) await tx.sender.replaceTrack(track);
    else p.addTrack(track, stream); // triggers renegotiation
    video = true;
    cbs?.onLocalStream(stream);
    reportMedia();
    return true;
  } catch (error) {
    stream.removeTrack(track);
    track.stop();
    reportMedia();
    cbs?.onError(mediaErrorCode(error, 'camera'));
    return false;
  }
}

function end(finalState: CallState = 'ended'): void {
  generation++;
  settleConsent(false); // close an open "call directly?" question
  clearTimers();
  if (peer && callId) endedCalls.add(callKey(peer, callId));
  stopStream(localStream);
  localStream = null;
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
  pendingIce = [];
  pendingOffer = null;
  makingOffer = false;
  renegotiationReady = false;
  iceRestartAttempted = false;
  iceRestarting = false;
  outgoing = false;
  answered = false;
  signalled = false;
  relayFailures = 0;
  candidates.reset();
  cbs?.onLocalStream(null);
  cbs?.onRemoteStream(null);
  cbs?.onSas('');
  setMode(null);
  // The final state carries {peer, video} so the UI can offer "retry".
  setState(finalState);
  peer = null;
  callId = null;
  video = false;
}
