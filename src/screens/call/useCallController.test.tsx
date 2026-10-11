// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallEventWire } from '../../lib/api';
import type { CallCallbacks, CallState } from '../../lib/call';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { callSas } from '../../lib/sas';
import { countingStorage } from './test-support';
import {
  useCallController,
  type CallControllerDeps,
  type CallEngine,
  type CallPeer,
  type CallSounds,
} from './useCallController';

const PEER = 'ana';
const ME = '1'.repeat(64);
const ANA = '2'.repeat(64);
const LOCAL = 'aa'.repeat(32);
const REMOTE = 'bb'.repeat(32);
const OTHER = 'cc'.repeat(32);
const T0 = 1_700_000_000_000;

let clock = T0;
let ids = 0;
/** A fresh call id, as call.ts makes them. */
const newId = () => `call${String(++ids).padStart(12, '0')}xxxxxxxxxxxxxxxx`;

/** call.ts as the controller sees it: the test plays its callbacks by hand. */
function fakeEngine() {
  let callbacks: CallCallbacks | null = null;
  const status = { busy: false, media: false };
  const engine = {
    initCall: vi.fn((c: CallCallbacks) => {
      callbacks = c;
    }),
    handleSignal: vi.fn(),
    startCall: vi.fn(async () => {}),
    acceptIncoming: vi.fn(async () => {}),
    rejectIncoming: vi.fn(),
    hangup: vi.fn(),
    hangupAndWait: vi.fn(async () => {}),
    teardownCall: vi.fn(),
    toggleMute: vi.fn(() => true),
    toggleCamera: vi.fn(async () => true),
    answerDirectConsent: vi.fn(),
    isCallBusy: vi.fn(() => status.busy),
    callHoldsMedia: vi.fn(() => status.media),
  } satisfies CallEngine;
  const cb = () => {
    if (!callbacks) throw new Error('initCall was not called');
    return callbacks;
  };
  return { engine, cb, status };
}

function fakeSounds() {
  return {
    startRingback: vi.fn(),
    startRingtone: vi.fn(),
    stopRinging: vi.fn(),
    blipConnect: vi.fn(),
    blipEnd: vi.fn(),
  } satisfies CallSounds;
}

/**
 * The controller with fakes for everything it is given. `deps` are the fakes,
 * for the assertions; `over` replaces some of them in what the controller gets.
 */
function setup(over: Partial<CallControllerDeps> = {}, ana: Partial<CallPeer> = {}) {
  const { engine, cb, status } = fakeEngine();
  const sounds = fakeSounds();
  const unlisten = vi.fn();
  const deps = {
    api: {
      notify: vi.fn(async (_title: string, _body: string) => {}),
      recordCall: vi.fn(async (peer: string, call: CallEventWire, startedAt: number) => ({ peer, ts: startedAt, call })),
    },
    events: { onCallSignal: vi.fn(async (_cb: (event: { from_handle: string; payload: string }) => void) => unlisten) },
    peer: vi.fn((handle: string): CallPeer | null =>
      handle === PEER ? { name: 'Ana Torres', avatar: null, verified: false, identityDigest: ANA, ...ana } : null,
    ),
    me: { identityDigest: ME },
    isWindowVisible: vi.fn(() => true),
    onVerified: vi.fn((_handle: string) => {}),
    onVerificationRevoked: vi.fn((_handle: string) => {}),
    ttlFor: vi.fn((_handle: string) => 0),
    capabilities: { callLog: true },
    alerts: {
      ringtone: vi.fn(() => ({ tone: 'soft' as const, volume: 60 }) as { tone: 'soft' | 'silent'; volume: number }),
      notifyWhenHidden: vi.fn(() => true),
      notifyWithName: vi.fn(() => true),
    },
    engine,
    sounds,
    now: () => clock,
  } satisfies CallControllerDeps;
  const given: CallControllerDeps = { ...deps, ...over };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nContext.Provider value={makeT('es')}>
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>{children}</LangCtx.Provider>
    </I18nContext.Provider>
  );
  const view = renderHook(() => useCallController(given), { wrapper });
  /** call.ts reports a state of the call `callId`. */
  const state = (s: CallState, callId: string, video = false) =>
    act(() => {
      status.busy = !['ended', 'rejected', 'idle'].includes(s);
      status.media = status.busy && s !== 'ringing-in';
      cb().onState(s, { peer: PEER, video, callId });
    });
  return { ...view, deps, engine, cb, status, sounds, unlisten, state };
}

type Setup = ReturnType<typeof setup>;

/** Place a call and get it to ring. */
function ringingOut(s: Setup, callId: string, video = false) {
  act(() => s.result.current.start(PEER, video));
  s.state('starting', callId, video);
  s.state('ringing-out', callId, video);
}

/** Place a call and get it connected, `seconds` later. */
function connectedCall(s: Setup, callId: string) {
  ringingOut(s, callId);
  clock += 2_000;
  s.state('connected', callId);
}

beforeEach(() => {
  clock = T0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useCallController', () => {
  describe('wiring', () => {
    it('drives call.ts with the call signals while it is mounted, and tears the call down after', async () => {
      const s = setup();
      expect(s.engine.initCall).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(s.deps.events.onCallSignal).toHaveBeenCalledTimes(1));
      const listener = s.deps.events.onCallSignal.mock.calls[0]![0] as (e: { from_handle: string; payload: string }) => void;
      listener({ from_handle: PEER, payload: '{"t":"bye"}' });
      expect(s.engine.handleSignal).toHaveBeenCalledWith(PEER, '{"t":"bye"}');
      await Promise.resolve();
      s.unmount();
      expect(s.unlisten).toHaveBeenCalledTimes(1);
      expect(s.engine.teardownCall).toHaveBeenCalledTimes(1);
      expect(s.sounds.stopRinging).toHaveBeenCalled();
    });

    it('places and answers calls through call.ts, audio only when asked', () => {
      const s = setup();
      act(() => s.result.current.start(PEER, true));
      expect(s.engine.startCall).toHaveBeenCalledWith(PEER, true);
      const id = newId();
      s.state('ringing-in', id, true);
      act(() => s.result.current.accept({ video: false }));
      expect(s.engine.acceptIncoming).toHaveBeenCalledWith({ video: false });
    });

    it('does not place a call while another is busy', () => {
      const s = setup();
      s.status.busy = true;
      act(() => s.result.current.start(PEER, false));
      expect(s.engine.startCall).not.toHaveBeenCalled();
    });
  });

  describe('the question of calling directly', () => {
    // docs/llamadas-turn.md: asked on every call, never remembered, Cancel by default.
    it('comes back on every call, even after a "yes" to the same contact', () => {
      const s = setup();
      const first = newId();
      act(() => s.result.current.start(PEER, false));
      s.state('starting', first);
      act(() => s.cb().onDirectConsent({ peer: PEER, outgoing: true }));
      expect(s.result.current.consent).toEqual({ peer: PEER, outgoing: true });
      act(() => s.result.current.answerConsent(true));
      expect(s.engine.answerDirectConsent.mock.calls).toEqual([[true]]);
      act(() => s.cb().onDirectConsent(null));
      expect(s.result.current.consent).toBeNull();
      s.state('ringing-out', first);
      s.state('connected', first);
      act(() => s.result.current.hangup());
      s.state('ended', first);
      act(() => s.result.current.dismissEnded());

      const second = newId();
      act(() => s.result.current.start(PEER, false));
      s.state('starting', second);
      act(() => s.cb().onDirectConsent({ peer: PEER, outgoing: true }));
      expect(s.result.current.consent).toEqual({ peer: PEER, outgoing: true });
      // Nothing answered it on its own: the first "yes" is the only answer so far.
      expect(s.engine.answerDirectConsent.mock.calls).toEqual([[true]]);
    });

    it('reads and writes no stored preference on the way', () => {
      const { storage, accesses } = countingStorage();
      vi.stubGlobal('localStorage', storage);
      const s = setup();
      const id = newId();
      act(() => s.result.current.start(PEER, false));
      s.state('starting', id);
      act(() => s.cb().onDirectConsent({ peer: PEER, outgoing: true }));
      act(() => s.result.current.answerConsent(true));
      act(() => s.cb().onDirectConsent(null));
      s.state('ringing-out', id);
      act(() => s.result.current.answerConsent(false));
      act(() => s.cb().onDirectConsent({ peer: PEER, outgoing: false }));
      act(() => s.result.current.answerConsent(false));
      expect(accesses).toEqual([]);
    });

    it('declines an incoming call on "no", and cancels an outgoing one', () => {
      const s = setup();
      const incoming = newId();
      s.state('ringing-in', incoming);
      act(() => s.result.current.accept());
      s.state('connecting', incoming);
      act(() => s.cb().onDirectConsent({ peer: PEER, outgoing: false }));
      act(() => s.result.current.answerConsent(false));
      expect(s.engine.answerDirectConsent).toHaveBeenLastCalledWith(false);
      s.state('ended', incoming);
      expect(s.deps.api.recordCall).toHaveBeenCalledTimes(1);
      expect(s.deps.api.recordCall.mock.calls[0]![1].outcome).toBe('declined');
      // A "no" before an outgoing call rang leaves no record and no end card.
      const outgoing = newId();
      act(() => s.result.current.start(PEER, false));
      s.state('starting', outgoing);
      act(() => s.cb().onDirectConsent({ peer: PEER, outgoing: true }));
      act(() => s.result.current.answerConsent(false));
      s.state('ended', outgoing);
      expect(s.deps.api.recordCall).toHaveBeenCalledTimes(1);
      expect(s.result.current.ended).toBeNull();
      expect(s.result.current.view).toBe('idle');
    });
  });

  it('follows how the call travels, as call.ts reports it', () => {
    const s = setup();
    expect(s.result.current.mode).toBeNull();
    act(() => s.cb().onConnectionMode('protected'));
    expect(s.result.current.mode).toBe('protected');
    act(() => s.cb().onConnectionMode('direct'));
    expect(s.result.current.mode).toBe('direct');
    act(() => s.cb().onConnectionMode(null));
    expect(s.result.current.mode).toBeNull();
  });

  describe('the call log', () => {
    it('records an answered call once, with its id, direction, length, start and the chat’s ttl', async () => {
      const ttlFor = vi.fn((_handle: string) => 3_600);
      const s = setup({ ttlFor });
      const id = newId();
      connectedCall(s, id);
      clock += 61_500;
      act(() => s.result.current.hangup());
      expect(s.engine.hangup).toHaveBeenCalledTimes(1);
      s.state('ended', id);
      s.state('ended', id); // a late copy of the same end
      expect(s.deps.api.recordCall.mock.calls).toEqual([
        [
          PEER,
          { id, direction: 'outgoing', video: false, outcome: 'answered', duration_sec: 61, ttl: 3_600 },
          Math.floor(T0 / 1000),
        ],
      ]);
      expect(ttlFor).toHaveBeenCalledWith(PEER);
    });

    it('records every outcome of the table once, with no ttl when the chat has none', () => {
      const s = setup();
      const outcome = (n: number) => s.deps.api.recordCall.mock.calls[n]![1];

      // The other person rejected it.
      const declined = newId();
      ringingOut(s, declined);
      s.state('rejected', declined);
      // Nobody picked up.
      const unanswered = newId();
      ringingOut(s, unanswered);
      act(() => s.cb().onError('no-answer'));
      s.state('ended', unanswered);
      // Hung up here while it rang.
      const cancelled = newId();
      ringingOut(s, cancelled);
      act(() => s.result.current.hangup());
      s.state('ended', cancelled);
      // The connection failed.
      const failed = newId();
      ringingOut(s, failed);
      s.state('connecting', failed);
      act(() => s.cb().onError('connection'));
      s.state('ended', failed);
      // Incoming: it stopped ringing.
      const missed = newId();
      s.state('ringing-in', missed, true);
      s.state('ended', missed, true);
      // Incoming: declined here.
      const rejected = newId();
      s.state('ringing-in', rejected);
      act(() => s.result.current.reject());
      expect(s.engine.rejectIncoming).toHaveBeenCalledTimes(1);
      s.state('ended', rejected);
      // Incoming: answered here, never connected.
      const lost = newId();
      s.state('ringing-in', lost);
      act(() => s.result.current.accept());
      s.state('connecting', lost);
      s.state('ended', lost);

      expect(s.deps.api.recordCall.mock.calls.map(([, call]) => [call.id, call.direction, call.outcome])).toEqual([
        [declined, 'outgoing', 'declined'],
        [unanswered, 'outgoing', 'unanswered'],
        [cancelled, 'outgoing', 'cancelled'],
        [failed, 'outgoing', 'failed'],
        [missed, 'incoming', 'missed'],
        [rejected, 'incoming', 'declined'],
        [lost, 'incoming', 'failed'],
      ]);
      expect(outcome(4)).toMatchObject({ video: true, duration_sec: 0, ttl: null });
    });

    it('records nothing for a call that never rang', () => {
      const s = setup();
      const id = newId();
      act(() => s.result.current.start(PEER, false));
      s.state('starting', id);
      act(() => s.cb().onError('microphone'));
      s.state('ended', id);
      expect(s.deps.api.recordCall).not.toHaveBeenCalled();
      expect(s.result.current.ended).toMatchObject({ reason: 'microphone', logged: false });
    });

    it('never records without the call log', () => {
      const s = setup({ capabilities: { callLog: false } });
      const id = newId();
      connectedCall(s, id);
      s.state('ended', id);
      expect(s.result.current.ended).toMatchObject({ reason: 'ended', logged: false });
      const missed = newId();
      s.state('ringing-in', missed);
      s.state('ended', missed);
      expect(s.deps.api.recordCall).not.toHaveBeenCalled();
    });

    it('says the call is in the chat only once the backend recorded it', async () => {
      const s = setup();
      const id = newId();
      connectedCall(s, id);
      s.state('ended', id);
      expect(s.result.current.ended).toMatchObject({ peer: PEER, reason: 'ended', logged: false });
      await waitFor(() => expect(s.result.current.ended?.logged).toBe(true));
    });

    it('only logs a record that failed', async () => {
      const recordCall = vi.fn(async () => {
        throw { code: 'no_vault', message: 'locked' };
      });
      const s = setup({ api: { notify: vi.fn(async () => {}), recordCall } });
      const id = newId();
      connectedCall(s, id);
      s.state('ended', id);
      await waitFor(() => expect(console.error).toHaveBeenCalled());
      expect(s.result.current.ended).toMatchObject({ reason: 'ended', logged: false });
    });
  });

  describe('the SAS of the call', () => {
    async function withSymbols(s: Setup, id: string) {
      connectedCall(s, id);
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: REMOTE }));
      await waitFor(() => expect(s.result.current.sas).not.toBeNull());
    }

    it('derives the 7 symbols from the call id, both identities and both fingerprints', async () => {
      const s = setup();
      const id = newId();
      await withSymbols(s, id);
      const expected = await callSas({ callId: id, idA: ME, idB: ANA, dtlsA: LOCAL, dtlsB: REMOTE });
      expect(s.result.current.sas).toEqual({ indices: expected, verified: false });
    });

    it('shows no symbols without both identity digests', async () => {
      const s = setup({}, { identityDigest: null });
      const id = newId();
      connectedCall(s, id);
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: REMOTE }));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(s.result.current.sas).toBeNull();
    });

    it('marks the contact as verified on "Coinciden"', async () => {
      const s = setup();
      const id = newId();
      await withSymbols(s, id);
      act(() => s.result.current.confirmMatch());
      expect(s.deps.onVerified.mock.calls).toEqual([[PEER]]);
      expect(s.result.current.sas?.verified).toBe(true);
    });

    // A "Coinciden" pressed by mistake: the other side reads out other symbols (review of W6).
    it('undoes a "Coinciden" of this call on "No coinciden", the mark included', async () => {
      const s = setup();
      const id = newId();
      await withSymbols(s, id);
      act(() => s.result.current.confirmMatch());
      act(() => s.result.current.reportMismatch());
      expect(s.deps.onVerificationRevoked.mock.calls).toEqual([[PEER]]);
      expect(s.result.current.sas?.verified).toBe(false);
      // The call goes on; a new fingerprint later on has no match of this call left to undo.
      expect(s.engine.hangup).not.toHaveBeenCalled();
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: OTHER }));
      expect(s.deps.onVerificationRevoked).toHaveBeenCalledTimes(1);
    });

    it('keeps the mark of a contact verified before the call on "No coinciden", but no longer calls the call verified', async () => {
      const s = setup({}, { verified: true });
      await withSymbols(s, newId());
      expect(s.result.current.sas?.verified).toBe(true);
      act(() => s.result.current.confirmMatch());
      act(() => s.result.current.reportMismatch());
      expect(s.deps.onVerificationRevoked).not.toHaveBeenCalled();
      expect(s.result.current.sas?.verified).toBe(false);
    });

    it('revokes nothing on "No coinciden" without a "Coinciden" before it', async () => {
      const s = setup();
      await withSymbols(s, newId());
      act(() => s.result.current.reportMismatch());
      act(() => s.result.current.reportMismatch());
      expect(s.deps.onVerificationRevoked).not.toHaveBeenCalled();
      expect(s.result.current.sas?.verified).toBe(false);
    });

    it('verifies again on a "Coinciden" after "No coinciden"', async () => {
      const s = setup();
      await withSymbols(s, newId());
      act(() => s.result.current.reportMismatch());
      act(() => s.result.current.confirmMatch());
      expect(s.deps.onVerified.mock.calls).toEqual([[PEER]]);
      expect(s.result.current.sas?.verified).toBe(true);
    });

    it('shows a contact verified before the call as verified', async () => {
      const s = setup({}, { verified: true });
      const id = newId();
      await withSymbols(s, id);
      expect(s.result.current.sas?.verified).toBe(true);
    });

    // docs/sas-v2.md, "The DTLS fingerprint rule".
    it('hangs up when the remote fingerprint changes after "Coinciden", and undoes that verification', async () => {
      const s = setup();
      const id = newId();
      await withSymbols(s, id);
      act(() => s.result.current.confirmMatch());
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: OTHER }));
      expect(s.engine.hangup).toHaveBeenCalledTimes(1);
      expect(s.deps.onVerificationRevoked.mock.calls).toEqual([[PEER]]);
      expect(s.result.current.sas).toBeNull();
      s.state('ended', id);
      expect(s.result.current.ended).toMatchObject({ reason: 'security' });
      expect(s.result.current.view).toBe('ended');
    });

    it('keeps the mark of a contact verified before the call', async () => {
      const s = setup({}, { verified: true });
      const id = newId();
      await withSymbols(s, id);
      act(() => s.result.current.confirmMatch());
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: OTHER }));
      expect(s.engine.hangup).toHaveBeenCalledTimes(1);
      expect(s.deps.onVerificationRevoked).not.toHaveBeenCalled();
    });

    it('hangs up on a new fingerprint without revoking anything when nobody matched', async () => {
      const s = setup();
      const id = newId();
      await withSymbols(s, id);
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: OTHER }));
      expect(s.engine.hangup).toHaveBeenCalledTimes(1);
      expect(s.deps.onVerificationRevoked).not.toHaveBeenCalled();
    });

    it('lets a renegotiation with the same fingerprint, or another call’s inputs, through', async () => {
      const s = setup();
      const id = newId();
      await withSymbols(s, id);
      act(() => s.cb().onSasInputs!({ callId: id, localDtls: LOCAL, remoteDtls: REMOTE }));
      act(() => s.cb().onSasInputs!({ callId: newId(), localDtls: LOCAL, remoteDtls: OTHER }));
      expect(s.engine.hangup).not.toHaveBeenCalled();
      expect(s.result.current.sas).not.toBeNull();
    });

    it('takes no "Coinciden" without symbols', () => {
      const s = setup();
      connectedCall(s, newId());
      act(() => s.result.current.confirmMatch());
      expect(s.deps.onVerified).not.toHaveBeenCalled();
    });
  });

  describe('ending a call to lock, close or quit', () => {
    it('lets it go at once when there is no call', async () => {
      const s = setup();
      await expect(s.result.current.confirmEnd('lock')).resolves.toBe(true);
      await expect(s.result.current.confirmEnd('close')).resolves.toBe(true);
      expect(s.result.current.endConfirm).toBeNull();
      expect(s.engine.hangupAndWait).not.toHaveBeenCalled();
    });

    it('asks first during a call, and keeps the call on "Cancelar"', async () => {
      const s = setup();
      connectedCall(s, newId());
      let answer: Promise<boolean> = Promise.resolve(true);
      act(() => {
        answer = s.result.current.confirmEnd('lock');
      });
      expect(s.result.current.endConfirm).toBe('lock');
      act(() => s.result.current.answerEndConfirm(false));
      await expect(answer).resolves.toBe(false);
      expect(s.result.current.endConfirm).toBeNull();
      expect(s.engine.hangupAndWait).not.toHaveBeenCalled();
    });

    it('hangs up, waits for the bye and for the record, then lets it go', async () => {
      let recorded = false;
      const recordCall = vi.fn(async (peer: string, call: CallEventWire, startedAt: number) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        recorded = true;
        return { peer, ts: startedAt, call };
      });
      const s = setup({ api: { notify: vi.fn(async () => {}), recordCall } });
      const id = newId();
      connectedCall(s, id);
      s.engine.hangupAndWait.mockImplementation(async () => {
        s.state('ended', id);
      });
      let answer: Promise<boolean> = Promise.resolve(false);
      act(() => {
        answer = s.result.current.confirmEnd('close');
      });
      expect(s.result.current.endConfirm).toBe('close');
      await act(async () => {
        s.result.current.answerEndConfirm(true);
        await expect(answer).resolves.toBe(true);
      });
      expect(s.engine.hangupAndWait).toHaveBeenCalledTimes(1);
      expect(recorded).toBe(true);
      expect(recordCall.mock.calls[0]![1].outcome).toBe('answered');
    });

    it('asks before closing only while the call holds the microphone', async () => {
      const s = setup();
      s.state('ringing-in', newId());
      await expect(s.result.current.confirmEnd('close')).resolves.toBe(true);
      let lock: Promise<boolean> = Promise.resolve(true);
      act(() => {
        lock = s.result.current.confirmEnd('lock');
      });
      expect(s.result.current.endConfirm).toBe('lock');
      act(() => s.result.current.answerEndConfirm(false));
      await expect(lock).resolves.toBe(false);
    });

    it('lets it go when the call ends by itself while it asks', async () => {
      const s = setup();
      const id = newId();
      connectedCall(s, id);
      let answer: Promise<boolean> = Promise.resolve(false);
      act(() => {
        answer = s.result.current.confirmEnd('lock');
      });
      s.state('ended', id);
      await expect(answer).resolves.toBe(true);
      expect(s.result.current.endConfirm).toBeNull();
    });

    // The tray's "Salir" already chose to quit, and the backend exits after a short grace.
    it('hangs up at once to quit, without asking', async () => {
      const s = setup();
      connectedCall(s, newId());
      await act(async () => {
        await expect(s.result.current.confirmEnd('quit')).resolves.toBe(true);
      });
      expect(s.result.current.endConfirm).toBeNull();
      expect(s.engine.hangupAndWait).toHaveBeenCalledTimes(1);
    });

    it('hangs up and waits for the lock of the vault', async () => {
      const s = setup();
      const id = newId();
      ringingOut(s, id);
      await act(async () => {
        await s.result.current.hangupAndWait();
      });
      expect(s.engine.hangupAndWait).toHaveBeenCalledTimes(1);
      s.state('ended', id);
      expect(s.deps.api.recordCall.mock.calls[0]![1].outcome).toBe('cancelled');
    });
  });

  describe('alerts', () => {
    it('notifies an incoming call while the window is hidden, with the name', () => {
      const s = setup({ isWindowVisible: vi.fn(() => false) });
      s.state('ringing-in', newId(), true);
      expect(s.deps.api.notify.mock.calls).toEqual([['Ana Torres', 'Videollamada entrante']]);
    });

    it('leaves the name out when the notifications hide it', () => {
      const s = setup({ isWindowVisible: vi.fn(() => false) });
      s.deps.alerts.notifyWithName.mockReturnValue(false);
      s.state('ringing-in', newId());
      expect(s.deps.api.notify.mock.calls).toEqual([['Trino', 'Llamada entrante']]);
    });

    it('does not notify with the window in sight, or when the notice is off', () => {
      const visible = setup();
      visible.state('ringing-in', newId());
      expect(visible.deps.api.notify).not.toHaveBeenCalled();
      const off = setup({ isWindowVisible: vi.fn(() => false) });
      off.deps.alerts.notifyWhenHidden.mockReturnValue(false);
      off.state('ringing-in', newId());
      expect(off.deps.api.notify).not.toHaveBeenCalled();
    });

    it('rings with the tone of Settings, and plays the call’s sounds', () => {
      const s = setup();
      s.deps.alerts.ringtone.mockReturnValue({ tone: 'silent', volume: 30 });
      const incoming = newId();
      s.state('ringing-in', incoming);
      expect(s.sounds.startRingtone).toHaveBeenCalledWith({ tone: 'silent', volume: 30 });
      s.state('ended', incoming);
      expect(s.sounds.stopRinging).toHaveBeenCalled();
      expect(s.sounds.blipEnd).not.toHaveBeenCalled(); // it only rang

      const outgoing = newId();
      ringingOut(s, outgoing);
      expect(s.sounds.startRingback).toHaveBeenCalledWith({ volume: 30 });
      s.state('connected', outgoing);
      s.state('connecting', outgoing);
      s.state('connected', outgoing);
      expect(s.sounds.blipConnect).toHaveBeenCalledTimes(1);
      s.state('ended', outgoing);
      expect(s.sounds.blipEnd).toHaveBeenCalledTimes(1);
    });

    it('shows a camera that failed during the call, without ending it', () => {
      const s = setup();
      connectedCall(s, newId());
      act(() => s.cb().onError('camera'));
      expect(s.result.current.notice).toBe('camera');
      expect(s.result.current.view).toBe('connected');
    });
  });

  describe('what the screens show', () => {
    it('goes through the moments of a call and ends on its card', () => {
      const s = setup();
      expect(s.result.current.view).toBe('idle');
      const id = newId();
      ringingOut(s, id);
      expect(s.result.current.view).toBe('ringing-out');
      expect(s.result.current.activePeer).toBe(PEER);
      expect(s.result.current.peer).toMatchObject({ handle: PEER, name: 'Ana Torres' });
      expect(s.result.current.direction).toBe('outgoing');
      clock += 1_000;
      s.state('connected', id);
      expect(s.result.current.view).toBe('connected');
      expect(s.result.current.connectedAt).toBe(clock);
      clock += 201_000;
      s.state('ended', id);
      expect(s.result.current.view).toBe('ended');
      expect(s.result.current.activePeer).toBeNull();
      expect(s.result.current.ended).toMatchObject({
        peer: PEER,
        name: 'Ana Torres',
        reason: 'ended',
        durationSec: 201,
        video: false,
      });
      act(() => s.result.current.dismissEnded());
      expect(s.result.current.view).toBe('idle');
    });

    it('calls again from the end card, with the same kind of call', () => {
      const s = setup();
      const id = newId();
      act(() => s.result.current.start(PEER, true));
      s.state('starting', id, true);
      s.state('ringing-out', id, true);
      s.state('rejected', id, true);
      expect(s.result.current.ended).toMatchObject({ reason: 'rejected', video: true });
      act(() => s.result.current.callAgain());
      expect(s.result.current.ended).toBeNull();
      expect(s.engine.startCall).toHaveBeenLastCalledWith(PEER, true);
    });

    it('rings without an end card when nobody answered here', () => {
      const s = setup();
      const id = newId();
      s.state('ringing-in', id);
      expect(s.result.current.view).toBe('incoming');
      expect(s.result.current.direction).toBe('incoming');
      s.state('ended', id);
      expect(s.result.current.view).toBe('idle');
    });

    it('shows the call again when a new one starts, even if the last one was minimized', () => {
      const s = setup();
      connectedCall(s, newId());
      act(() => s.result.current.setMinimized(true));
      expect(s.result.current.minimized).toBe(true);
      s.state('ringing-in', newId());
      expect(s.result.current.minimized).toBe(false);
    });

    it('mutes and switches the camera through call.ts', () => {
      const s = setup();
      connectedCall(s, newId());
      act(() => s.result.current.toggleMute());
      act(() => s.result.current.toggleCamera());
      expect(s.engine.toggleMute).toHaveBeenCalledTimes(1);
      expect(s.engine.toggleCamera).toHaveBeenCalledTimes(1);
      act(() => s.cb().onMedia({ muted: true, cameraOn: true, hasVideo: true }));
      expect(s.result.current.media).toEqual({ muted: true, cameraOn: true, hasVideo: true });
      expect(s.result.current.video).toBe(true);
    });
  });
});
