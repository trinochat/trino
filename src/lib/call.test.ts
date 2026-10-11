import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// call.ts talks to the backend only through `api`; these mocks stand in for it.
const api = vi.hoisted(() => ({
  getTurnServers: vi.fn(),
  getCallConfig: vi.fn(),
  sendCallSignal: vi.fn(),
  setCallActive: vi.fn(),
  devLog: vi.fn(),
}));
vi.mock('./api', () => ({ api }));

type CallModule = typeof import('./call');

const PEER = 'ana';
const OFFER_ID = 'c'.repeat(32);
const TURN = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turns:turn.cloudflare.com:443?transport=tcp',
  ],
  username: 'u1',
  credential: 'c1',
};
const STUN = { urls: ['stun:stun.l.google.com:19302'] };

const HOST_LAN = 'candidate:1 1 udp 2122260223 192.168.1.20 56143 typ host generation 0';
const SRFLX = 'candidate:3 1 udp 1686052607 81.2.69.142 61000 typ srflx raddr 192.168.1.20 rport 56143 generation 0';
const RELAY = 'candidate:4 1 udp 41885439 104.30.1.2 3478 typ relay raddr 81.2.69.142 rport 61000 generation 0';
const RELAY_SCRUBBED = RELAY.replace('raddr 81.2.69.142 rport 61000', 'raddr 0.0.0.0 rport 0');
const SRFLX_SCRUBBED = SRFLX.replace('raddr 192.168.1.20 rport 56143', 'raddr 0.0.0.0 rport 0');

const PROTECTED_CONFIG = {
  iceServers: [TURN],
  iceTransportPolicy: 'relay',
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 0,
};
const DIRECT_CONFIG = {
  iceServers: [STUN],
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 0,
};

// A Chromium-shaped description; with candidates it carries every kind of leak.
function sdp(type: 'offer' | 'answer', withCandidates: boolean): string {
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

class FakePc {
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

function fakeStream(video: boolean) {
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

const getUserMedia = vi.fn();
const storage = { getItem: vi.fn() };

function turnOk(servers: unknown[] = [TURN]) {
  return { ice_servers: servers, expires_at: Math.floor(Date.now() / 1000) + 14_400 };
}

const TURN_DOWN = { code: 'io', message: 'turn: network error: timed out' };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

let current: CallModule | null = null;

async function setup() {
  vi.resetModules();
  const call = await import('./call');
  current = call;
  const cb = {
    onState: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onSas: vi.fn(),
    onError: vi.fn(),
    onMedia: vi.fn(),
    onConnectionMode: vi.fn(),
    onDirectConsent: vi.fn(),
  };
  call.initCall(cb);
  return { call, cb };
}

/** Every signal handed to the backend, parsed. */
function sent(): { to: string; signal: Record<string, any> }[] {
  return api.sendCallSignal.mock.calls.map(([to, payload]) => ({
    to,
    signal: JSON.parse(payload),
  }));
}

function sentCandidates(): string[] {
  return sent()
    .filter(s => s.signal.t === 'ice')
    .map(s => s.signal.candidate.candidate);
}

function sdpCandidates(text: string): string[] {
  return text
    .split('\r\n')
    .filter(line => line.startsWith('a=candidate:'))
    .map(line => line.slice(2));
}

function lastState(cb: { onState: ReturnType<typeof vi.fn> }): unknown {
  const calls = cb.onState.mock.calls;
  return calls[calls.length - 1]?.[0];
}

function consentRequests(cb: { onDirectConsent: ReturnType<typeof vi.fn> }): unknown[] {
  return cb.onDirectConsent.mock.calls.map(([request]) => request).filter(Boolean);
}

function answerFrom(callId: string): string {
  return JSON.stringify({ t: 'answer', callId, sdp: sdp('answer', false) });
}

/** A promise the test settles by hand, for a TURN request still in flight. */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Place a call and get it answered and connected. */
async function connectedCall(call: CallModule): Promise<FakePc> {
  await call.startCall(PEER, false);
  const pc = FakePc.instances[FakePc.instances.length - 1]!;
  call.handleSignal(PEER, answerFrom(sent()[0]!.signal.callId));
  await Promise.resolve();
  await Promise.resolve();
  pc.moveTo('connected');
  return pc;
}

function offerFrom(callId = OFFER_ID): string {
  return JSON.stringify({ t: 'offer', callId, sdp: sdp('offer', false), video: false });
}

beforeEach(() => {
  FakePc.instances = [];
  for (const mock of Object.values(api)) mock.mockReset();
  api.sendCallSignal.mockResolvedValue(undefined);
  api.setCallActive.mockResolvedValue(undefined);
  api.devLog.mockResolvedValue(undefined);
  api.getCallConfig.mockResolvedValue({ ice_servers: [STUN] });
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async (constraints: { video: unknown }) =>
    fakeStream(!!constraints.video),
  );
  storage.getItem.mockReset();
  storage.getItem.mockReturnValue(null);
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('localStorage', storage);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  current?.teardownCall(); // clears ring timers so they cannot fire into the next test
  current = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('connection setup', () => {
  it('places a protected call through TURN only, relay-only and bundled', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    await call.startCall(PEER, false);
    expect(FakePc.instances).toHaveLength(1);
    expect(FakePc.instances[0]!.config).toEqual(PROTECTED_CONFIG);
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith('protected');
    expect(lastState(cb)).toBe('ringing-out');
    expect(consentRequests(cb)).toEqual([]);
  });

  it('keeps only the TURN entries of what the backend returns', async () => {
    const noCredential = { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: '' };
    api.getTurnServers.mockResolvedValue(turnOk([STUN, TURN, noCredential]));
    const { call } = await setup();
    await call.startCall(PEER, false);
    expect(FakePc.instances[0]!.config.iceServers).toEqual([TURN]);
  });

  it('treats an answer with no usable TURN server as a failure', async () => {
    api.getTurnServers.mockResolvedValue(turnOk([STUN]));
    const { call, cb } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    expect(consentRequests(cb)).toEqual([{ peer: PEER, outgoing: true }]);
    expect(FakePc.instances).toHaveLength(0);
    call.answerDirectConsent(false);
    await placing;
  });

  it('never loads the STUN configuration for a protected call, not even at start-up', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    await settle();
    expect(api.getCallConfig).not.toHaveBeenCalled();
    await call.startCall(PEER, false);
    expect(api.getCallConfig).not.toHaveBeenCalled();
  });
});

describe('relay-only candidate filter', () => {
  it('holds everything until the answer, then sends only the relay candidate, scrubbed', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    await call.startCall(PEER, false);
    const offer = sent()[0]!.signal;
    expect(offer.t).toBe('offer');
    expect(sdpCandidates(offer.sdp)).toEqual([]);
    expect(offer.sdp).not.toMatch(/192\.168\.|81\.2\.69\.142|104\.30\.1\.2/);

    const pc = FakePc.instances[0]!;
    pc.gather(HOST_LAN);
    pc.gather(SRFLX);
    pc.gather(RELAY);
    expect(sent()).toHaveLength(1); // nothing leaves before the answer

    call.handleSignal(PEER, answerFrom(offer.callId));
    await settle();
    expect(sentCandidates()).toEqual([RELAY_SCRUBBED]);

    pc.gather(SRFLX); // trickled later: still filtered
    pc.gather(HOST_LAN);
    expect(sentCandidates()).toEqual([RELAY_SCRUBBED]);
  });

  it('stays relay-only with the LAN developer switch on', async () => {
    storage.getItem.mockReturnValue('1');
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    await call.startCall(PEER, false);
    const pc = FakePc.instances[0]!;
    pc.gather(HOST_LAN);
    pc.gather(RELAY);
    call.handleSignal(PEER, answerFrom(sent()[0]!.signal.callId));
    await settle();
    expect(sentCandidates()).toEqual([RELAY_SCRUBBED]);
  });

  it('keeps the public filter in a consented direct call', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    call.answerDirectConsent(true);
    await placing;
    const pc = FakePc.instances[0]!;
    pc.gather(HOST_LAN);
    pc.gather(SRFLX);
    pc.gather(RELAY);
    call.handleSignal(PEER, answerFrom(sent()[0]!.signal.callId));
    await settle();
    expect(sentCandidates()).toEqual([SRFLX_SCRUBBED, RELAY_SCRUBBED]);
  });
});

describe('no silent fallback to a direct call', () => {
  it('asks before going direct, with the microphone still closed and nothing sent', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    expect(consentRequests(cb)).toEqual([{ peer: PEER, outgoing: true }]);
    expect(lastState(cb)).toBe('starting');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
    expect(api.getCallConfig).not.toHaveBeenCalled();
    expect(api.sendCallSignal).not.toHaveBeenCalled();
    call.answerDirectConsent(false);
    await placing;
  });

  it('cancels the call when the user says no', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    call.answerDirectConsent(false);
    await placing;
    expect(lastState(cb)).toBe('ended');
    expect(cb.onDirectConsent).toHaveBeenLastCalledWith(null);
    expect(cb.onConnectionMode).not.toHaveBeenCalledWith('direct');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
    expect(api.getCallConfig).not.toHaveBeenCalled();
    expect(api.sendCallSignal).not.toHaveBeenCalled();
  });

  it('calls directly, with the STUN configuration, only after an explicit yes', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    call.answerDirectConsent(true);
    await placing;
    expect(cb.onDirectConsent).toHaveBeenLastCalledWith(null);
    expect(api.getCallConfig).toHaveBeenCalledTimes(1);
    expect(FakePc.instances[0]!.config).toEqual(DIRECT_CONFIG);
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith('direct');
    expect(sent().map(s => s.signal.t)).toEqual(['offer']);
    expect(lastState(cb)).toBe('ringing-out');
  });

  it('closes the question and opens nothing when the call is torn down meanwhile', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    call.teardownCall();
    expect(cb.onDirectConsent).toHaveBeenLastCalledWith(null);
    await placing;
    call.answerDirectConsent(true); // a late click
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
    expect(api.getCallConfig).not.toHaveBeenCalled();
  });

  it('reports no connection mode once the call is over', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    await call.startCall(PEER, false);
    call.hangup();
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith(null);
  });
});

describe('hanging up before anything was sent', () => {
  it('sends nothing when the caller hangs up while TURN is being fetched', async () => {
    const turn = pending<unknown>();
    api.getTurnServers.mockReturnValue(turn.promise);
    const { call, cb } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    expect(lastState(cb)).toBe('starting');
    call.hangup();
    turn.resolve(turnOk());
    await placing;
    expect(api.sendCallSignal).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
    expect(lastState(cb)).toBe('ended');
  });

  it('sends nothing when the app locks or closes while TURN is being fetched', async () => {
    const turn = pending<unknown>();
    api.getTurnServers.mockReturnValue(turn.promise);
    const { call } = await setup();
    const placing = call.startCall(PEER, false);
    await settle();
    await call.hangupAndWait(50);
    turn.resolve(turnOk());
    await placing;
    expect(api.sendCallSignal).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
  });

  it('sends nothing when an accepted call is hung up before the answer went out', async () => {
    const turn = pending<unknown>();
    api.getTurnServers.mockReturnValue(turn.promise);
    const { call } = await setup();
    call.handleSignal(PEER, offerFrom());
    const accepting = call.acceptIncoming();
    await settle();
    call.hangup();
    turn.resolve(turnOk());
    await accepting;
    expect(api.sendCallSignal).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('says bye once the offer has gone out', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    await call.startCall(PEER, false);
    call.hangup();
    expect(sent().map(s => s.signal.t)).toEqual(['offer', 'bye']);
  });
});

describe('relay credentials during a call', () => {
  const FRESH = { ...TURN, username: 'u2', credential: 'c2' };

  function expiringIn(seconds: number) {
    return { ice_servers: [TURN], expires_at: Math.floor(Date.now() / 1000) + seconds };
  }

  it('refreshes credentials that expire during the call, staying on the relay', async () => {
    vi.useFakeTimers();
    api.getTurnServers
      .mockResolvedValueOnce(expiringIn(11 * 60))
      .mockResolvedValueOnce(turnOk([FRESH]));
    const { call, cb } = await setup();
    const pc = await connectedCall(call);
    expect(pc.updates).toEqual([]);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(api.getTurnServers).toHaveBeenCalledTimes(2);
    expect(pc.updates).toEqual([{ ...PROTECTED_CONFIG, iceServers: [FRESH] }]);
    expect(lastState(cb)).toBe('connected');
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith('protected');
    expect(consentRequests(cb)).toEqual([]);
  });

  it('never goes direct when a refresh fails', async () => {
    vi.useFakeTimers();
    api.getTurnServers
      .mockResolvedValueOnce(expiringIn(11 * 60))
      .mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    const pc = await connectedCall(call);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(api.getTurnServers.mock.calls.length).toBeGreaterThan(1);
    expect(pc.updates).toEqual([]);
    expect(consentRequests(cb)).toEqual([]);
    expect(api.getCallConfig).not.toHaveBeenCalled();
    expect(cb.onConnectionMode).not.toHaveBeenCalledWith('direct');
    expect(lastState(cb)).toBe('connected');
  });

  it('stops refreshing when the call ends', async () => {
    vi.useFakeTimers();
    api.getTurnServers.mockResolvedValue(expiringIn(11 * 60));
    const { call } = await setup();
    await connectedCall(call);
    call.hangup();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(api.getTurnServers).toHaveBeenCalledTimes(1);
  });

  it('takes fresh credentials before an ICE restart', async () => {
    api.getTurnServers.mockResolvedValueOnce(turnOk()).mockResolvedValueOnce(turnOk([FRESH]));
    const { call } = await setup();
    const pc = await connectedCall(call);
    pc.moveTo('failed');
    await settle();
    expect(pc.log).toEqual(['setConfiguration', 'restartIce']);
    expect(pc.updates).toEqual([{ ...PROTECTED_CONFIG, iceServers: [FRESH] }]);
    expect(sent().filter(s => s.signal.t === 'offer')).toHaveLength(2);
  });

  it('never asks for TURN again in a consented direct call', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call } = await setup();
    const placing = connectedCall(call);
    await settle();
    call.answerDirectConsent(true);
    const pc = await placing;
    pc.moveTo('failed');
    await settle();
    expect(api.getTurnServers).toHaveBeenCalledTimes(1);
    expect(pc.log).toEqual(['restartIce']);
  });
});

describe('caching interplay', () => {
  it('asks the backend on every call, which owns the cache and its expiry', async () => {
    api.getTurnServers
      .mockResolvedValueOnce(turnOk())
      .mockResolvedValueOnce(turnOk([{ ...TURN, username: 'u2', credential: 'c2' }]));
    const { call } = await setup();
    await call.startCall(PEER, false);
    call.hangup();
    await call.startCall(PEER, false);
    expect(api.getTurnServers).toHaveBeenCalledTimes(2);
    expect(FakePc.instances[1]!.config.iceServers).toEqual([
      { ...TURN, username: 'u2', credential: 'c2' },
    ]);
  });

  it('does not remember a failure: the next call is protected again', async () => {
    api.getTurnServers.mockRejectedValueOnce(TURN_DOWN).mockResolvedValueOnce(turnOk());
    const { call, cb } = await setup();
    const first = call.startCall(PEER, false);
    await settle();
    call.answerDirectConsent(false);
    await first;
    await call.startCall(PEER, false);
    expect(consentRequests(cb)).toHaveLength(1);
    expect(FakePc.instances[0]!.config).toEqual(PROTECTED_CONFIG);
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith('protected');
  });

  it('does not remember consent: every unprotected call asks again', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    const first = call.startCall(PEER, false);
    await settle();
    call.answerDirectConsent(true);
    await first;
    call.hangup();

    const second = call.startCall(PEER, false);
    await settle();
    expect(consentRequests(cb)).toHaveLength(2);
    expect(FakePc.instances).toHaveLength(1); // nothing new until answered
    call.answerDirectConsent(false);
    await second;
    expect(FakePc.instances).toHaveLength(1);
  });
});

describe('answering', () => {
  it('fetches TURN only once the call is accepted, then answers relay-only', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    call.handleSignal(PEER, offerFrom());
    expect(lastState(cb)).toBe('ringing-in');
    await settle();
    expect(api.getTurnServers).not.toHaveBeenCalled(); // ringing alone reaches nobody

    await call.acceptIncoming();
    expect(FakePc.instances[0]!.config).toEqual(PROTECTED_CONFIG);
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith('protected');
    const answer = sent().find(s => s.signal.t === 'answer')!;
    expect(answer.to).toBe(PEER);
    expect(sdpCandidates(answer.signal.sdp)).toEqual([RELAY_SCRUBBED]);
    expect(answer.signal.sdp).not.toMatch(/192\.168\.|81\.2\.69\.142/);
  });

  it('asks before answering directly, and declines the call on no', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    call.handleSignal(PEER, offerFrom());
    const accepting = call.acceptIncoming();
    await settle();
    expect(consentRequests(cb)).toEqual([{ peer: PEER, outgoing: false }]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
    call.answerDirectConsent(false);
    await accepting;
    expect(sent().map(s => s.signal.t)).toEqual(['reject']);
    expect(lastState(cb)).toBe('ended');
    expect(cb.onDirectConsent).toHaveBeenLastCalledWith(null);
    expect(api.getCallConfig).not.toHaveBeenCalled();
  });

  it('answers directly with the public filter after an explicit yes', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    call.handleSignal(PEER, offerFrom());
    const accepting = call.acceptIncoming();
    await settle();
    call.answerDirectConsent(true);
    await accepting;
    expect(FakePc.instances[0]!.config).toEqual(DIRECT_CONFIG);
    expect(cb.onConnectionMode).toHaveBeenLastCalledWith('direct');
    const answer = sent().find(s => s.signal.t === 'answer')!;
    expect(sdpCandidates(answer.signal.sdp)).toEqual([SRFLX_SCRUBBED, RELAY_SCRUBBED]);
  });

  it('closes the question when the caller hangs up while it is open', async () => {
    api.getTurnServers.mockRejectedValue(TURN_DOWN);
    const { call, cb } = await setup();
    call.handleSignal(PEER, offerFrom());
    const accepting = call.acceptIncoming();
    await settle();
    call.handleSignal(PEER, JSON.stringify({ t: 'bye', callId: OFFER_ID }));
    expect(cb.onDirectConsent).toHaveBeenLastCalledWith(null);
    await accepting;
    expect(lastState(cb)).toBe('ended');
    call.answerDirectConsent(true); // a late click
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakePc.instances).toHaveLength(0);
    expect(api.getCallConfig).not.toHaveBeenCalled();
    expect(api.sendCallSignal).not.toHaveBeenCalled();
  });
});

// Additions for the redesigned call screen (W6). Nothing here changes what
// goes on the wire or how TURN is used; the old screen keeps working as it is.
describe('additions for the redesigned call screen', () => {
  const LOCAL_DTLS = 'aa' + '01'.repeat(31);
  const REMOTE_DTLS = 'bb' + '01'.repeat(31);

  function videoOfferFrom(callId = OFFER_ID): string {
    return JSON.stringify({ t: 'offer', callId, sdp: sdp('offer', false), video: true });
  }

  it('answers a video call with audio only when asked to', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    call.handleSignal(PEER, videoOfferFrom());
    await call.acceptIncoming({ video: false });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]![0].video).toBe(false);
    expect(cb.onState).toHaveBeenCalledWith('connecting', expect.objectContaining({ video: false }));
    expect(sent().map(s => s.signal.t)).toEqual(['answer']);
  });

  it('still answers a video call with video by default', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    call.handleSignal(PEER, videoOfferFrom());
    await call.acceptIncoming();
    expect(getUserMedia.mock.calls[0]![0].video).not.toBe(false);
  });

  it('never turns a voice call into a video call when answering', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    call.handleSignal(PEER, offerFrom());
    await call.acceptIncoming({ video: true });
    expect(getUserMedia.mock.calls[0]![0].video).toBe(false);
  });

  it("tells every state which call it belongs to, the final one included", async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    await call.startCall(PEER, false);
    const id = sent()[0]!.signal.callId;
    call.hangup();
    expect(cb.onState.mock.calls.map(([state, info]) => [state, info.callId])).toEqual([
      ['starting', id],
      ['ringing-out', id],
      ['ended', id],
    ]);
  });

  it('gives the ringing state the id of the incoming call', async () => {
    const { call, cb } = await setup();
    call.handleSignal(PEER, offerFrom());
    expect(cb.onState).toHaveBeenLastCalledWith('ringing-in', { peer: PEER, video: false, callId: OFFER_ID });
  });

  it('hands over the inputs of the SAS: the call id and both DTLS fingerprints, lowercase and without colons', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    const onSasInputs = vi.fn();
    call.initCall({ ...(await setupCallbacks()), onSasInputs });
    await connectedCall(call);
    await settle();
    const id = sent()[0]!.signal.callId;
    expect(onSasInputs).toHaveBeenCalledWith({ callId: id, localDtls: LOCAL_DTLS, remoteDtls: REMOTE_DTLS });
  });

  it('hands them over when answering, too', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    const onSasInputs = vi.fn();
    call.initCall({ ...(await setupCallbacks()), onSasInputs });
    call.handleSignal(PEER, offerFrom());
    await call.acceptIncoming();
    await settle();
    // Answering, the offer is the remote description and the answer the local one.
    expect(onSasInputs).toHaveBeenCalledWith({ callId: OFFER_ID, localDtls: REMOTE_DTLS, remoteDtls: LOCAL_DTLS });
  });

  it('hands them over again when the other side renegotiates, so a new fingerprint is noticed', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    const onSasInputs = vi.fn();
    call.initCall({ ...(await setupCallbacks()), onSasInputs });
    await connectedCall(call);
    await settle();
    const id = sent()[0]!.signal.callId;
    const other = 'cc' + '02'.repeat(31);
    const renegotiation = sdp('offer', false).replace(/AA(:01){31}/, 'CC' + ':02'.repeat(31));
    call.handleSignal(PEER, JSON.stringify({ t: 'offer', callId: id, sdp: renegotiation, renegotiate: true }));
    await settle();
    expect(onSasInputs).toHaveBeenLastCalledWith(expect.objectContaining({ callId: id, remoteDtls: other }));
  });

  it('says nothing about a call that ended while its SAS was being worked out', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    let ended = false;
    call.initCall({
      ...(await setupCallbacks()),
      onSas: cb.onSas,
      onSasInputs: () => {
        if (!ended) {
          ended = true;
          call.hangup(); // as the redesign does when a fingerprint changes
        }
      },
    });
    await connectedCall(call);
    await settle();
    expect(cb.onSas).toHaveBeenLastCalledWith('');
  });
});

/** A fresh set of the required callbacks, for a test that adds an optional one. */
async function setupCallbacks() {
  return {
    onState: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onSas: vi.fn(),
    onError: vi.fn(),
    onMedia: vi.fn(),
    onConnectionMode: vi.fn(),
    onDirectConsent: vi.fn(),
  };
}
