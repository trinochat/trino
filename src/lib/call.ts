// call.ts — 1:1 voice/video calls over WebRTC (professional rewrite).
//
// Media (audio/video) is encrypted by WebRTC's DTLS-SRTP. It is sent directly
// when ICE can establish a peer route, or through a configured TURN server when
// NAT/firewall rules require a relay. Signaling rides trino's E2E channel via
// send_call_signal.
//
// Design notes:
// - Explicit offer/answer for call setup (predictable ringing UX), plus
//   glare-safe renegotiation for mid-call changes (e.g. turning the camera on
//   during a voice call).
// - Errors are surfaced through onError instead of being swallowed.
// - getUserMedia degrades gracefully: a video call with no camera falls back to
//   audio rather than failing silently.
// - Connection drops are handled leniently — a transient `disconnected` gets a
//   grace period before the call is torn down; only `failed`/`closed` end it.
// - Ring/answer timeouts prevent calls from hanging forever.

import { api } from './api';

export type CallState =
  | 'idle'
  | 'ringing-out' // we called, waiting for them
  | 'ringing-in' // they called, waiting for us
  | 'connecting'
  | 'connected'
  | 'rejected' // they declined our outgoing call
  | 'ended';

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

export interface CallCallbacks {
  onState: (s: CallState, info: { peer: string | null; video: boolean }) => void;
  onLocalStream: (s: MediaStream | null) => void;
  onRemoteStream: (s: MediaStream | null) => void;
  // Short Authentication String (Telegram-style emoji code) from the DTLS
  // fingerprints. Identical on both peers when there's no man-in-the-middle.
  onSas: (emojis: string) => void;
  onError: (code: CallErrorCode) => void;
  // Current mute / camera state so the UI can reflect the real track status.
  onMedia: (m: MediaState) => void;
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
const DISCONNECT_GRACE_MS = 12_000; // let ICE try to recover before tearing down
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_SDP_CHARS = 56 * 1024;
const MAX_PENDING_ICE = 128;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
let iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;

export function configureIceServers(servers: RTCIceServer[]): void {
  const valid = servers.filter(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return (
      urls.length > 0 &&
      urls.every(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url))
    );
  });
  iceServers = valid.length > 0 ? valid : DEFAULT_ICE_SERVERS;
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
  if (!pc || !cbs) return;
  const a = parseFp(pc.localDescription?.sdp);
  const b = parseFp(pc.remoteDescription?.sdp);
  if (!a || !b) return;
  const joined = [a, b].sort().join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  const bytes = new Uint8Array(digest);
  const emojis = Array.from({ length: 5 }, (_, i) => SAS_EMOJIS[bytes[i]! % SAS_EMOJIS.length]);
  cbs.onSas(emojis.join(' '));
}

// ── module state ────────────────────────────────────────────────────────────
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let peer: string | null = null;
let callId: string | null = null;
let video = false; // whether this call negotiated a video track
let polite = false; // callee is polite; used for glare-free renegotiation
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
let iceRestartAttempted = false;
let iceRestarting = false;

export function initCall(callbacks: CallCallbacks): void {
  cbs = callbacks;
}

function rid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
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

function clearTimers(): void {
  if (ringTimer) clearTimeout(ringTimer);
  if (disconnectTimer) clearTimeout(disconnectTimer);
  ringTimer = null;
  disconnectTimer = null;
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
async function getMedia(withVideo: boolean): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 24, max: 30 },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: withVideo ? videoConstraints : false,
    });
  } catch (e) {
    if (withVideo) {
      video = false;
      try {
        return await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (audioError) {
        throw audioError;
      }
    }
    throw e;
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

function makePc(remote: string, id: string): RTCPeerConnection {
  const p = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });

  p.onicecandidate = e => {
    if (e.candidate) {
      void send(remote, { t: 'ice', callId: id, candidate: e.candidate.toJSON() });
    }
  };

  p.ontrack = e => {
    const stream = e.streams[0] ?? null;
    cbs?.onRemoteStream(stream);
    if (e.track.kind === 'video') {
      video = true;
      cbs?.onState(p.connectionState === 'connected' ? 'connected' : 'connecting', { peer, video });
    }
  };

  // Glare-safe renegotiation: when tracks change (e.g. camera turned on), emit a
  // fresh offer. Only fires after the initial exchange thanks to makingOffer.
  p.onnegotiationneeded = async () => {
    // Ignore the automatic negotiation triggered by the initial addTrack — the
    // first offer/answer is created manually. Only renegotiate (e.g. camera
    // turned on) once the call is established.
    if (
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
      await send(remote, {
        t: 'offer',
        callId: id,
        sdp: p.localDescription?.sdp,
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
      cbs?.onState('connected', { peer, video });
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
  cbs?.onState('connecting', { peer, video });
  try {
    makingOffer = true;
    connection.restartIce();
    const offer = await connection.createOffer({ iceRestart: true });
    await connection.setLocalDescription(offer);
    await waitIceComplete(connection, 5_000);
    const sent = await send(remote, {
      t: 'offer',
      callId: id,
      sdp: connection.localDescription?.sdp ?? offer.sdp,
      video,
      renegotiate: true,
    });
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

// Wait until ICE gathering finishes so the offer/answer SDP already carries all
// candidates. Trickle-ICE over the slow Nostr signaling channel loses/delays
// candidates and the call never finds a working pair; sending one complete SDP
// is far more reliable. Capped so a stuck TURN probe can't hang the call.
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
  api.devLog(`startCall remote=${remote} video=${withVideo} cbs=${!!cbs} busy=${!!pc || !!pendingOffer}`);
  if (pc || pendingOffer) return; // already in a call
  peer = remote;
  callId = rid();
  video = withVideo;
  polite = false; // caller is impolite (wins glare)
  cbs?.onState('ringing-out', { peer, video });
  try {
    localStream = await getMedia(withVideo);
  } catch (error) {
    api.devLog('startCall getMedia FAILED');
    cbs?.onError(mediaErrorCode(error, 'microphone'));
    end();
    return;
  }
  api.devLog(`startCall got media, tracks=${localStream.getTracks().length}`);
  cbs?.onLocalStream(localStream);
  reportMedia();
  try {
    pc = makePc(remote, callId);
    localStream.getTracks().forEach(t => pc!.addTrack(t, localStream!));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc); // send SDP with candidates already embedded
    const sent = await send(remote, {
      t: 'offer',
      callId,
      sdp: pc.localDescription?.sdp ?? offer.sdp,
      video,
    });
    if (!sent) {
      end();
      return;
    }
    api.devLog(`offer sent, iceState=${pc.iceGatheringState}`);
    armRingTimeout();
  } catch (error) {
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
export async function acceptIncoming(): Promise<void> {
  if (!pendingOffer) return;
  const { from, sig } = pendingOffer;
  pendingOffer = null;
  clearRing();
  peer = from;
  callId = sig.callId;
  video = !!sig.video;
  polite = true; // callee is polite
  cbs?.onState('connecting', { peer, video });
  try {
    localStream = await getMedia(video);
  } catch (error) {
    cbs?.onError(mediaErrorCode(error, 'microphone'));
    void send(from, { t: 'reject', callId: sig.callId });
    end();
    return;
  }
  cbs?.onLocalStream(localStream);
  reportMedia();
  try {
    pc = makePc(from, sig.callId);
    await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
    localStream.getTracks().forEach(t => pc!.addTrack(t, localStream!));
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc); // answer SDP carries our candidates
    const sent = await send(from, {
      t: 'answer',
      callId: sig.callId,
      sdp: pc.localDescription?.sdp ?? answer.sdp,
    });
    if (!sent) {
      end();
      return;
    }
    api.devLog(`answer sent, iceState=${pc.iceGatheringState}`);
    void computeSas();
  } catch (error) {
    console.error('incoming call setup failed', error);
    cbs?.onError('connection');
    void send(from, { t: 'reject', callId: sig.callId });
    end();
  }
}

export function rejectIncoming(): void {
  if (pendingOffer) {
    void send(pendingOffer.from, { t: 'reject', callId: pendingOffer.sig.callId });
  }
  end();
}

export function hangup(): void {
  if (peer && callId) void send(peer, { t: 'bye', callId });
  end();
}

// ── incoming signals ────────────────────────────────────────────────────────
export function handleSignal(from: string, payload: string): void {
  const s = parseSignal(payload);
  if (!s) {
    console.warn('[CALL] invalid signal payload');
    return;
  }
  api.devLog(
    `recv ${s.t} reneg=${!!s.renegotiate} pc=${!!pc} pending=${!!pendingOffer} cbs=${!!cbs} callId=${callId} sig=${s.callId}`,
  );

  // Initial offer (no active call): ring, don't auto-answer.
  if (s.t === 'offer' && !s.renegotiate && !pc && !pendingOffer) {
    pendingOffer = { from, sig: s };
    peer = from;
    callId = s.callId;
    video = !!s.video;
    api.devLog(`-> ringing-in for ${from} video=${video}`);
    cbs?.onState('ringing-in', { peer, video });
    ringTimer = setTimeout(() => rejectIncoming(), RING_TIMEOUT_MS);
    return;
  }

  // A fresh offer from the SAME peer is a retry (they hung up and called
  // again, or their bye got lost) — replace the stale call instead of
  // busy-declining it. Declining here made an accepted call look rejected.
  if (
    s.t === 'offer' &&
    !s.renegotiate &&
    from === peer &&
    pc?.connectionState !== 'connected'
  ) {
    api.devLog(`same-peer retry offer ${s.callId} replaces ${callId}`);
    if (pc) end();
    pendingOffer = { from, sig: s };
    peer = from;
    callId = s.callId;
    video = !!s.video;
    cbs?.onState('ringing-in', { peer, video });
    clearRing();
    ringTimer = setTimeout(() => rejectIncoming(), RING_TIMEOUT_MS);
    return;
  }

  // A second incoming call from someone ELSE while busy → politely decline.
  if (s.t === 'offer' && !s.renegotiate && (pc || pendingOffer) && s.callId !== callId) {
    void send(from, { t: 'reject', callId: s.callId });
    return;
  }

  if (s.callId !== callId) return; // stale / different call

  if (s.t === 'offer' && s.renegotiate && pc) {
    void handleRenegotiation(from, s);
  } else if (s.t === 'answer' && pc) {
    pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
      .then(async () => {
        await flushIce();
        await computeSas();
      })
      .catch(err => {
        console.error('setRemoteDescription(answer) failed', err);
        cbs?.onError('connection');
        end();
      });
  } else if (s.t === 'ice' && s.candidate) {
    if (pc && pc.remoteDescription) pc.addIceCandidate(s.candidate).catch(() => {});
    else if (pendingIce.length < MAX_PENDING_ICE) pendingIce.push(s.candidate);
  } else if (s.t === 'bye' || s.t === 'reject') {
    // A reject on our outgoing call shows the "rejected" screen (close/retry);
    // a bye (peer hung up) just ends.
    end(s.t === 'reject' ? 'rejected' : 'ended');
  }
}

// Perfect-negotiation collision handling for mid-call renegotiation.
async function handleRenegotiation(from: string, s: Signal): Promise<void> {
  if (!pc) return;
  const collision = makingOffer || pc.signalingState !== 'stable';
  if (!polite && collision) return; // impolite peer ignores the colliding offer
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    const sent = await send(from, {
      t: 'answer',
      callId: s.callId,
      sdp: pc.localDescription?.sdp ?? answer.sdp,
      renegotiate: true,
    });
    if (!sent) end();
  } catch (err) {
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

// Turn the camera on/off. In a video call this just toggles the track. In a
// voice call, the first "on" acquires a camera and renegotiates to add video.
export async function toggleCamera(): Promise<boolean> {
  if (!pc || !localStream) return false;
  const existing = localStream.getVideoTracks()[0];
  if (existing) {
    existing.enabled = !existing.enabled;
    reportMedia();
    return existing.enabled;
  }
  // No video track yet → acquire camera and add it (triggers renegotiation).
  try {
    const cam = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = cam.getVideoTracks()[0]!;
    localStream.addTrack(track);
    pc.addTrack(track, localStream);
    video = true;
    cbs?.onLocalStream(localStream);
    reportMedia();
    return true;
  } catch (error) {
    cbs?.onError(mediaErrorCode(error, 'camera'));
    return false;
  }
}

function end(finalState: CallState = 'ended'): void {
  clearTimers();
  localStream?.getTracks().forEach(t => t.stop());
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
  cbs?.onLocalStream(null);
  cbs?.onRemoteStream(null);
  cbs?.onSas('');
  // The final state carries {peer, video} so the UI can offer "retry".
  cbs?.onState(finalState, { peer, video });
  peer = null;
  callId = null;
  video = false;
}
