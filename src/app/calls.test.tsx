// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdAccessibility, holdAppearance, holdScanLines } from '../design/apply';
import { AppearanceProvider } from '../design/useAppearance';
import type { CallEventWire, CallSignalEvent } from '../lib/api';
import { FakePc, STUN, TURN_DOWN, fakeStream, sdp, settle, turnOk } from '../lib/call-test-support';
import type { CallSounds } from '../screens/call';
import { fakeHost, memoryPrefs, node, withLang } from '../screens/settings/test-utils';
import { useCalls, type CallGate, type CallsBackend, type CallsOptions } from './calls';

// The calls (plan §4, I5; plan-cambios-11oct §7, I5): W6's controller and
// screens over the real call.ts, which talks to the fake RTCPeerConnection
// of call.test.ts (src/lib/call-test-support.ts) and to a fake backend. A
// bare frame stands for the shell here: how the call lies over the real
// shell, and over Settings in its main pane, is src/app/MainScreen.test.tsx.

// call.ts reaches the backend through lib/api's `api`.
const backend = vi.hoisted(() => ({
  getTurnServers: vi.fn(),
  getCallConfig: vi.fn(),
  sendCallSignal: vi.fn(),
  setCallActive: vi.fn(),
  devLog: vi.fn(),
}));
vi.mock('../lib/api', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return { ...original, api: { ...original.api, ...backend } };
});

const ME = '1'.repeat(64);
const FP = 'ab12.cd34.ef56.7890';
const BETO_FP = '0000.1111.2222.3333';
const ANA = node('Ana', { fingerprint: FP, identity_digest: '2'.repeat(64) });
const BETO = node('Beto', { fingerprint: BETO_FP, identity_digest: '3'.repeat(64) });
// call.ts lives on from test to test and remembers the calls that ended: each offer has its own id.
let offers = 0;
const newOfferId = () => `offer${String(++offers).padStart(27, '0')}`;

const getUserMedia = vi.fn();

beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
  // "Tu código QR" draws the QR's PNG on a canvas, which jsdom does not have.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  FakePc.instances = [];
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.getTurnServers.mockResolvedValue(turnOk());
  backend.getCallConfig.mockResolvedValue({ ice_servers: [STUN] });
  backend.sendCallSignal.mockResolvedValue(undefined);
  backend.setCallActive.mockResolvedValue(undefined);
  backend.devLog.mockResolvedValue(undefined);
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async (constraints: { video: unknown }) => fakeStream(!!constraints.video));
  vi.stubGlobal('RTCPeerConnection', FakePc);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});
afterEach(() => {
  // Unmounting hangs up: the controller tears the call down.
  cleanup();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What the calls ask of the backend beside call.ts: notifications, the call log and the signals. */
function callBackend() {
  let heard: ((event: CallSignalEvent) => void) | null = null;
  const api = {
    notify: vi.fn(async (_title: string, _body: string) => {}),
    recordCall: vi.fn(async (peer: string, call: CallEventWire, startedAt: number) => ({ peer, ts: startedAt, call })),
    onCallSignal: vi.fn(async (cb: (event: CallSignalEvent) => void) => {
      heard = cb;
      return () => {
        heard = null;
      };
    }),
  } satisfies CallsBackend;
  /** A call signal from `from` reaches this device, as the backend's `call-signal` event. */
  const signal = (from: string, payload: object) =>
    act(async () => {
      heard!({ from_handle: from, payload: JSON.stringify(payload) });
      await settle();
    });
  return { api, signal };
}

const quiet = (): CallSounds => ({
  startRingback: vi.fn(),
  startRingtone: vi.fn(),
  stopRinging: vi.fn(),
  blipConnect: vi.fn(),
  blipEnd: vi.fn(),
});

interface MountOptions {
  /** What this device keeps: verification marks, chat timers. */
  stored?: Record<string, string>;
  over?: Partial<CallsOptions>;
}

function mount({ stored = {}, over = {} }: MountOptions = {}) {
  const { prefs, storage } = memoryPrefs(stored);
  const calls = callBackend();
  const sounds = quiet();
  const gate: { current: CallGate | null } = { current: null };

  function Frame() {
    const ui = useCalls({
      contacts: [ANA, BETO],
      myIdentityDigest: ME,
      isWindowVisible: () => true,
      callLog: true,
      api: calls.api,
      prefs,
      sounds,
      ...over,
    });
    gate.current = ui.gate;
    return (
      <div className="relative flex h-full flex-col">
        {ui.slot.bar}
        <div inert={ui.slot.covering}>
          <button type="button" onClick={() => ui.slot.start('Ana', false)}>
            Llamar a Ana
          </button>
        </div>
        {ui.slot.layer}
      </div>
    );
  }

  const { host } = fakeHost();
  render(
    withLang(
      <AppearanceProvider host={host}>
        <Frame />
      </AppearanceProvider>,
    ),
  );
  return { storage, gate, ...calls };
}

const callScreen = (name = 'Ana') => screen.queryByRole('region', { name: `Llamada en curso con ${name}` });
/** Every signal call.ts handed to the backend, parsed. */
const sent = () =>
  backend.sendCallSignal.mock.calls.map(([to, payload]) => ({ to: to as string, signal: JSON.parse(payload as string) }));
const press = (button: HTMLElement) =>
  act(async () => {
    fireEvent.click(button);
    await settle();
  });
const placeCall = () => press(screen.getByRole('button', { name: 'Llamar a Ana' }));

/** Place a call to Ana, and get it answered and connected. */
async function connectedCall(signal: ReturnType<typeof callBackend>['signal']) {
  await placeCall();
  const callId: string = sent()[0]!.signal.callId;
  await signal('Ana', { t: 'answer', callId, sdp: sdp('answer', false) });
  await act(async () => {
    FakePc.instances[0]!.moveTo('connected');
    await settle();
  });
  return callId;
}

describe('the calls', () => {
  // docs/sas-v2.md, "The DTLS fingerprint rule": a different fingerprint after the first answer
  // ends the call, and undoes a "Coinciden" given in it for a contact not verified before.
  it('ends the call and takes the mark back when the fingerprint changes after "Coinciden"', async () => {
    const { storage, signal } = mount();
    const callId = await connectedCall(signal);

    fireEvent.click(await screen.findByRole('button', { name: /^Símbolos de la llamada: / }));
    fireEvent.click(screen.getByRole('button', { name: 'Coinciden' }));
    expect(storage.data.get('verified:Ana')).toBe(`call:${FP}`);
    expect(screen.getByRole('button', { name: /^Llamada verificada\. Símbolos: / })).toBeTruthy();

    const otherKey = sdp('offer', false).replace(/AA(:01){31}/, 'CC' + ':02'.repeat(31));
    await signal('Ana', { t: 'offer', callId, sdp: otherKey, renegotiate: true });

    expect(storage.data.has('verified:Ana')).toBe(false);
    expect(callScreen()).toBeNull();
    screen.getByRole('alertdialog', {
      name: 'Cambió la clave de la conexión',
      description:
        'La llamada terminó porque cambió la clave de la conexión. Vuelve a llamar y comparen los símbolos otra vez.',
    });
    expect(sent().map(s => s.signal.t)).toContain('bye');
  });

  // docs/llamadas-turn.md: asked on every call, never remembered, and the safe answer is the default.
  it('asks before calling directly when TURN is down, with "Cancelar" focused, and asks again after a yes', async () => {
    backend.getTurnServers.mockRejectedValue(TURN_DOWN);
    mount();
    await placeCall();
    let question = screen.getByRole('alertdialog', {
      name: 'No se pudo proteger la llamada.',
      description: '¿Llamar sin protección? Tu contacto verá desde dónde te conectas.',
    });
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Cancelar' }));
    expect(FakePc.instances).toHaveLength(0);

    await press(within(question).getByRole('button', { name: 'Llamar' }));
    expect(FakePc.instances).toHaveLength(1);
    expect(FakePc.instances[0]!.config.iceTransportPolicy).toBe('all');
    await press(within(callScreen()!).getByRole('button', { name: 'Colgar' }));
    expect(callScreen()).toBeNull();

    await placeCall();
    question = screen.getByRole('alertdialog', { name: 'No se pudo proteger la llamada.' });
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Cancelar' }));
    await press(within(question).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(FakePc.instances).toHaveLength(1);
    expect(sent().filter(s => s.signal.t === 'offer')).toHaveLength(1);
  });

  it('counts a contact as verified only by the mark of a call: one of 0.1.0 does not count', async () => {
    const { signal } = mount({ stored: { 'verified:Ana': `call:${FP}`, 'verified:Beto': BETO_FP } });
    await signal('Ana', { t: 'offer', callId: newOfferId(), sdp: sdp('offer', false), video: false });
    const ana = screen.getByRole('alertdialog', { name: 'Ana' });
    expect(within(ana).getByText('Contacto verificado')).toBeTruthy();
    await press(within(ana).getByRole('button', { name: 'Rechazar' }));

    await signal('Beto', { t: 'offer', callId: newOfferId(), sdp: sdp('offer', false), video: false });
    const beto = screen.getByRole('alertdialog', { name: 'Beto' });
    expect(within(beto).queryByText('Contacto verificado')).toBeNull();
  });

  it('records a call in its chat, with the timer of that chat', async () => {
    const { api, signal } = mount({ stored: { 'ttl:Ana': '3600' } });
    const callId = await connectedCall(signal);
    await press(within(callScreen()!).getByRole('button', { name: 'Colgar' }));

    expect(api.recordCall).toHaveBeenCalledTimes(1);
    const [peer, call] = api.recordCall.mock.calls[0]!;
    expect(peer).toBe('Ana');
    expect(call).toMatchObject({ id: callId, direction: 'outgoing', outcome: 'answered', ttl: 3600 });
  });

  it('records nothing while the shell says there is no call log', async () => {
    const { api } = mount({ over: { callLog: false } });
    await placeCall();
    await press(within(callScreen()!).getByRole('button', { name: 'Colgar' }));
    expect(api.recordCall).not.toHaveBeenCalled();
  });

  // What App asks before locking (and closing): during a call, the call asks first and hangs up on yes.
  it('hands App a gate that asks before ending a call, and hangs up on yes', async () => {
    const { gate } = mount();
    await expect(gate.current!.confirmEnd('lock')).resolves.toBe(true);

    await placeCall();
    let answer!: Promise<boolean>;
    act(() => {
      answer = gate.current!.confirmEnd('lock');
    });
    const ask = screen.getByRole('alertdialog', { name: 'Hay una llamada en curso' });
    await press(within(ask).getByRole('button', { name: 'Colgar y bloquear' }));
    await expect(answer).resolves.toBe(true);
    expect(callScreen()).toBeNull();
    expect(sent().map(s => s.signal.t)).toEqual(['offer', 'bye']);
  });
});
