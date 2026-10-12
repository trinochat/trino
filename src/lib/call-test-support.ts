/**
 * For the tests of calls only: nothing in the app imports this file. A
 * WebRTC stand-in shaped like Chromium's, so the real call.ts runs without a
 * browser: src/lib/call.test.ts, and the calls of the old shell
 * (src/app/calls.test.tsx).
 */
import { vi } from 'vitest';

export const TURN = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turns:turn.cloudflare.com:443?transport=tcp',
  ],
  username: 'u1',
  credential: 'c1',
};
export const STUN = { urls: ['stun:stun.l.google.com:19302'] };

export const HOST_LAN = 'candidate:1 1 udp 2122260223 192.168.1.20 56143 typ host generation 0';
export const SRFLX = 'candidate:3 1 udp 1686052607 81.2.69.142 61000 typ srflx raddr 192.168.1.20 rport 56143 generation 0';
export const RELAY = 'candidate:4 1 udp 41885439 104.30.1.2 3478 typ relay raddr 81.2.69.142 rport 61000 generation 0';

// A Chromium-shaped description; with candidates it carries every kind of leak.
export function sdp(type: 'offer' | 'answer', withCandidates: boolean): string {
  const fingerprint = (type === 'offer' ? 'AA' : 'BB') + ':01'.repeat(31);
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 61000 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 81.2.69.142',
    ...(withCandidates ? [`a=${HOST_LAN}`, `a=${SRFLX}`, `a=${RELAY}`] : []),
    'a=ice-ufrag:abcd',
    'a=ice-pwd:0123456789abcdefghijklmn',
    `a=fingerprint:sha-256 ${fingerprint}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n');
}

export class FakePc {
  static instances: FakePc[] = [];
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null =
    null;
  ontrack: unknown = null;
  onnegotiationneeded: unknown = null;
  onconnectionstatechange: unknown = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = 'stable';
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  /** Configurations applied after construction, and the order of calls. */
  updates: RTCConfiguration[] = [];
  log: string[] = [];

  constructor(readonly config: RTCConfiguration) {
    FakePc.instances.push(this);
  }

  addTrack(): object {
    return {};
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: sdp('offer', true) };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: sdp('answer', true) };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(): Promise<void> {}
  addEventListener(): void {}
  removeEventListener(): void {}
  getSenders(): unknown[] {
    return [];
  }
  getTransceivers(): unknown[] {
    return [];
  }
  setConfiguration(config: RTCConfiguration): void {
    this.updates.push(config);
    this.log.push('setConfiguration');
  }
  restartIce(): void {
    this.log.push('restartIce');
  }
  close(): void {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }

  /** The connection moved to `state`. */
  moveTo(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    (this.onconnectionstatechange as (() => void) | null)?.();
  }

  /** ICE gathered a candidate. */
  gather(candidate: string): void {
    this.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) },
    });
  }
}

export function fakeStream(video: boolean) {
  const tracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
    ...(video ? [{ kind: 'video', enabled: true, stop: vi.fn() }] : []),
  ];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
  };
}

/** `get_turn_servers` as the backend answers when TURN works. */
export function turnOk(servers: unknown[] = [TURN]) {
  return { ice_servers: servers, expires_at: Math.floor(Date.now() / 1000) + 14_400 };
}

/** `get_turn_servers` failing, as when the Worker cannot be reached. */
export const TURN_DOWN = { code: 'io', message: 'turn: network error: timed out' };

/** Lets the async steps of a call run their course. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
}
