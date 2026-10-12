import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakePc,
  HOST_LAN,
  RELAY,
  SRFLX,
  STUN,
  TURN,
  TURN_DOWN,
  fakeStream,
  sdp,
  settle,
  turnOk,
} from './call-test-support';

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

const getUserMedia = vi.fn();
const storage = { getItem: vi.fn() };

let current: CallModule | null = null;

async function setup() {
  vi.resetModules();
  const call = await import('./call');
  current = call;
  const cb = {
    onState: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onError: vi.fn(),
    onMedia: vi.fn(),
    onConnectionMode: vi.fn(),
    onDirectConsent: vi.fn(),
    onSasInputs: vi.fn(),
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
// goes on the wire or how TURN is used.
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

  // The call screen hangs up from onSasInputs when a fingerprint changes: the call ends there, with
  // its bye, and the connection that is gone has nothing more to say.
  it('ends the call at once when the screen hangs up from onSasInputs', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    const cb = await setupCallbacks();
    const onSasInputs = vi.fn(() => call.hangup());
    call.initCall({ ...cb, onSasInputs });
    await connectedCall(call);
    await settle();
    expect(onSasInputs).toHaveBeenCalledTimes(1);
    expect(lastState(cb)).toBe('ended');
    expect(sent().map(s => s.signal.t)).toContain('bye');
  });
});

/** A fresh set of the callbacks, for a test that brings its own onSasInputs. */
async function setupCallbacks() {
  return {
    onState: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onError: vi.fn(),
    onMedia: vi.fn(),
    onConnectionMode: vi.fn(),
    onDirectConsent: vi.fn(),
  };
}

// The call screen's device menus (12 Oct 2026): a microphone or a camera is switched in place, with
// replaceTrack and no renegotiation, and a choice made while nothing is open is kept for later. A
// switch that fails leaves the call as it was and is the screen's to tell: it never reaches onError,
// whose errors explain why a call ended.
describe('choosing the devices of a call', () => {
  type Track = { kind: string; enabled: boolean; stop: ReturnType<typeof vi.fn>; getSettings(): { deviceId: string } };

  function deviceOf(constraint: unknown, fallback: string): string {
    const id = (constraint as { deviceId?: { exact?: string; ideal?: string } } | undefined)?.deviceId;
    return id?.exact ?? id?.ideal ?? fallback;
  }

  function track(kind: string, deviceId: string): Track {
    return { kind, enabled: true, stop: vi.fn(), getSettings: () => ({ deviceId }) };
  }

  function liveStream(tracks: Track[]) {
    return {
      getTracks: () => [...tracks],
      getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
      getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
      addTrack: (t: Track) => tracks.push(t),
      removeTrack: (t: Track) => tracks.splice(tracks.indexOf(t), 1),
    };
  }

  beforeEach(() => {
    getUserMedia.mockImplementation(async (constraints: { audio?: unknown; video?: unknown }) =>
      liveStream([
        ...(constraints.audio ? [track('audio', deviceOf(constraints.audio, 'default'))] : []),
        ...(constraints.video ? [track('video', deviceOf(constraints.video, 'cam-1'))] : []),
      ]),
    );
  });

  /** The sender of the call's track of `kind`, which follows replaceTrack. */
  function senderFor(pc: FakePc, kind: 'audio' | 'video', current: Track) {
    const sender = {
      track: current as Track | null,
      replaceTrack: vi.fn(async (next: Track | null) => {
        sender.track = next;
      }),
    };
    const senders = (pc.getSenders() as unknown[]).concat(sender);
    pc.getSenders = () => senders;
    pc.getTransceivers = () => (kind === 'video' ? [{ receiver: { track: { kind } }, direction: 'sendrecv', sender }] : []);
    return sender;
  }

  const lastMedia = (cb: { onMedia: ReturnType<typeof vi.fn> }) => cb.onMedia.mock.calls.slice(-1)[0]?.[0];

  it('switches the microphone in place, keeping it muted, and says which one is in use', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    const pc = await connectedCall(call);
    const stream = cb.onLocalStream.mock.calls.find(([s]) => s)![0] as ReturnType<typeof liveStream>;
    const before = stream.getAudioTracks()[0]!;
    const sender = senderFor(pc, 'audio', before);
    expect(lastMedia(cb)).toEqual(expect.objectContaining({ microphoneId: 'default' }));
    call.toggleMute();

    await call.selectMicrophone('usb');

    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb' } }) });
    const after = stream.getAudioTracks()[0]!;
    expect(after).not.toBe(before);
    expect(sender.replaceTrack).toHaveBeenCalledWith(after);
    expect(after.enabled).toBe(false);
    expect(before.stop).toHaveBeenCalled();
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(lastMedia(cb)).toEqual(expect.objectContaining({ muted: true, microphoneId: 'usb' }));
    expect(sent().filter(s => s.signal.t === 'offer')).toHaveLength(1);
  });

  it('keeps the microphone it has when the chosen one cannot be opened, and leaves onError alone', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    const pc = await connectedCall(call);
    const stream = cb.onLocalStream.mock.calls.find(([s]) => s)![0] as ReturnType<typeof liveStream>;
    const before = stream.getAudioTracks()[0]!;
    const sender = senderFor(pc, 'audio', before);
    getUserMedia.mockRejectedValueOnce(new DOMException('gone', 'NotFoundError'));

    await expect(call.selectMicrophone('gone')).rejects.toBeTruthy();

    expect(stream.getAudioTracks()).toEqual([before]);
    expect(before.stop).not.toHaveBeenCalled();
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(lastState(cb)).toBe('connected');
  });

  it('opens the next call with the chosen microphone, falling back to another if it is gone', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call } = await setup();
    await call.selectMicrophone('usb');
    expect(getUserMedia).not.toHaveBeenCalled();
    await call.startCall(PEER, false);
    expect(getUserMedia.mock.calls[0]![0].audio).toEqual(expect.objectContaining({ deviceId: { ideal: 'usb' } }));
  });

  it('remembers the chosen camera while it is off, and opens it when it turns on', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    await connectedCall(call);
    getUserMedia.mockClear();

    await call.selectCamera('cam-2');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(lastMedia(cb)).toEqual(expect.objectContaining({ cameraOn: false, cameraId: 'cam-2' }));

    await call.toggleCamera();
    expect(getUserMedia).toHaveBeenCalledWith({ video: expect.objectContaining({ deviceId: { ideal: 'cam-2' } }) });
    expect(lastMedia(cb)).toEqual(expect.objectContaining({ cameraOn: true, cameraId: 'cam-2' }));
  });

  it('switches a camera that is on in place, and shows it in the preview', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    const pc = await connectedCall(call);
    await call.toggleCamera();
    const stream = cb.onLocalStream.mock.calls.find(([s]) => s)![0] as ReturnType<typeof liveStream>;
    const before = stream.getVideoTracks()[0]!;
    const sender = senderFor(pc, 'video', before);
    cb.onLocalStream.mockClear();

    await call.selectCamera('cam-2');

    expect(getUserMedia).toHaveBeenLastCalledWith({ video: expect.objectContaining({ deviceId: { exact: 'cam-2' } }) });
    const after = stream.getVideoTracks()[0]!;
    expect(sender.replaceTrack).toHaveBeenCalledWith(after);
    expect(before.stop).toHaveBeenCalled();
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(cb.onLocalStream).toHaveBeenCalledWith(stream);
    expect(lastMedia(cb)).toEqual(expect.objectContaining({ cameraOn: true, cameraId: 'cam-2' }));
  });

  it('keeps the camera it has when the chosen one cannot be opened', async () => {
    api.getTurnServers.mockResolvedValue(turnOk());
    const { call, cb } = await setup();
    const pc = await connectedCall(call);
    await call.toggleCamera();
    const stream = cb.onLocalStream.mock.calls.find(([s]) => s)![0] as ReturnType<typeof liveStream>;
    const before = stream.getVideoTracks()[0]!;
    const sender = senderFor(pc, 'video', before);
    getUserMedia.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));

    await expect(call.selectCamera('cam-2')).rejects.toBeTruthy();

    expect(stream.getVideoTracks()).toEqual([before]);
    expect(before.stop).not.toHaveBeenCalled();
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });
});
