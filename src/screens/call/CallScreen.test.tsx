// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sasWords } from '../../lib/sas-symbols';
import type { CallDevices } from './CallMediaSink';
import { CallScreen, type CallScreenProps } from './CallScreen';
import { fakeController, renderIn } from './test-support';
import type { CallController } from './useCallController';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const INDICES = [0, 44, 12, 43, 27, 37, 42];

const NO_DEVICES: CallDevices = { microphones: [], outputs: [], cameras: [] };

function show(over: Partial<CallController> = {}, props: Partial<CallScreenProps> = {}) {
  const controller = fakeController(over);
  const onSinkChange = vi.fn();
  const view = renderIn(
    <CallScreen controller={controller} devices={NO_DEVICES} sinkId={undefined} onSinkChange={onSinkChange} {...props} />,
  );
  return { ...view, controller, onSinkChange };
}

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label }) as MediaDeviceInfo;
const DEVICES: CallDevices = {
  microphones: [
    device('audioinput', 'default', 'Predeterminado - Micrófono (Realtek)'),
    device('audioinput', 'usb', 'Micrófono USB'),
  ],
  outputs: [
    device('audiooutput', 'default', 'Predeterminado - Altavoces (Realtek(R) Audio)'),
    device('audiooutput', 'usb-out', 'Audífonos USB'),
  ],
  cameras: [device('videoinput', 'cam-1', 'Cámara integrada'), device('videoinput', 'cam-2', 'Cámara USB')],
};
const choices = () => screen.getAllByRole('menuitemradio');
const names = (items: HTMLElement[]) => items.map(item => item.textContent);
const checked = () =>
  choices()
    .filter(item => item.getAttribute('aria-checked') === 'true')
    .map(item => item.textContent);

const callScreen = () => screen.getByRole('region', { name: 'Llamada en curso con Ana Torres' });

describe('CallScreen', () => {
  it('is the call with its contact (Call:82-100)', () => {
    show();
    expect(callScreen()).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ana Torres' })).toBeTruthy();
  });

  it('says it is calling, then connecting, then the time since it connected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { rerender, controller } = show({ view: 'ringing-out' });
    expect(callScreen().textContent).toContain('Llamando…');
    rerender(
      <CallScreen controller={{ ...controller, view: 'connecting' }} devices={NO_DEVICES} sinkId={undefined} onSinkChange={() => {}} />,
    );
    expect(callScreen().textContent).toContain('Conectando…');
    rerender(
      <CallScreen
        controller={{ ...controller, view: 'connected', connectedAt: 1_000_000 - 201_000 }}
        devices={NO_DEVICES}
        sinkId={undefined}
        onSinkChange={() => {}}
      />,
    );
    expect(callScreen().textContent).toContain('03:21');
  });

  it('says how the call travels only once it is known, and not while it rings', () => {
    const { unmount } = show({ mode: null });
    expect(callScreen().textContent).not.toMatch(/Conexión/);
    unmount();
    const ringing = show({ view: 'ringing-out', mode: 'protected' });
    expect(callScreen().textContent).not.toMatch(/Conexión/);
    ringing.unmount();
    show({ mode: 'direct', connectedAt: Date.now() });
    expect(screen.getByRole('button', { name: 'Conexión directa' })).toBeTruthy();
  });

  // Tor design §9.3, R-11 and PropTorSimple card 12: while Tor connects the
  // call keeps ringing, and the screen says so in one line, read out.
  it('says the call keeps ringing while it still connects privately', () => {
    const { unmount } = show({ view: 'ringing-out' });
    expect(callScreen().textContent).not.toMatch(/Todavía conectando/);
    unmount();
    show({ view: 'ringing-out', waitingForTor: true });
    expect(screen.getByRole('status').textContent).toBe('Todavía conectando de forma privada. La llamada sigue sonando…');
  });

  it('shows no call quality: there is no measure of it yet', () => {
    show({ mode: 'protected' });
    expect(screen.queryByRole('img', { name: /calidad/i })).toBeNull();
    expect(callScreen().textContent).not.toMatch(/calidad/i);
  });

  it('shows the key of the call at the top only when there are symbols', () => {
    const { unmount } = show();
    expect(screen.queryByRole('button', { name: /^Símbolos de la llamada/ })).toBeNull();
    unmount();
    const { controller } = show({ sas: { indices: INDICES, verified: false } });
    const key = screen.getByRole('button', { name: `Símbolos de la llamada: ${sasWords(INDICES, 'es').join(', ')}` });
    expect(key.querySelectorAll('svg[data-sas]')).toHaveLength(7);
    fireEvent.click(key);
    fireEvent.click(screen.getByRole('button', { name: 'Coinciden' }));
    expect(controller.confirmMatch).toHaveBeenCalledTimes(1);
  });

  // A box that clips (overflow-hidden) loses its automatic minimum height in the card's column: the stage then
  // never grew with the open comparison, and cut "Coinciden" and "No coinciden" off at 150 % text in 1024×700,
  // in the smallest window, and under the alert of "No coinciden" (review of W6, measured in headless Edge).
  // Only the call screen itself scrolls; whatever clips between it and the answers grows with what it holds.
  it('lets the open comparison grow the call card instead of cutting its answers off', () => {
    show({ sas: { indices: INDICES, verified: false } });
    fireEvent.click(screen.getByRole('button', { name: /^Símbolos de la llamada/ }));
    fireEvent.click(screen.getByRole('button', { name: 'No coinciden' }));
    const clipping: string[] = [];
    for (const answer of [screen.getByRole('button', { name: 'Coinciden' }), screen.getByRole('button', { name: 'No coinciden' })]) {
      for (let box = answer.parentElement; box && box !== callScreen(); box = box.parentElement) {
        if (/(?:^|\s)overflow-(?:y-)?(?:hidden|clip|auto|scroll)(?:\s|$)/.test(box.className) && !box.classList.contains('min-h-min')) {
          clipping.push(box.className);
        }
      }
    }
    expect(clipping).toEqual([]);
  });

  it('tells the controller when the symbols do not match', () => {
    const { controller } = show({ sas: { indices: INDICES, verified: false } });
    fireEvent.click(screen.getByRole('button', { name: /^Símbolos de la llamada/ }));
    fireEvent.click(screen.getByRole('button', { name: 'No coinciden' }));
    expect(controller.reportMismatch).toHaveBeenCalledTimes(1);
    expect(controller.confirmMatch).not.toHaveBeenCalled();
  });

  it('mutes and switches the camera with toggles whose icon shows the state', () => {
    const { controller, unmount } = show();
    const mute = screen.getByRole('button', { name: 'Silenciar micrófono' });
    const camera = screen.getByRole('button', { name: 'Encender cámara' });
    expect([mute.getAttribute('aria-pressed'), camera.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
    expect(mute.querySelector('svg')!.getAttribute('class')).toContain('lucide-mic ');
    expect(camera.querySelector('svg')!.getAttribute('class')).toContain('lucide-video-off');
    fireEvent.click(mute);
    fireEvent.click(camera);
    expect(controller.toggleMute).toHaveBeenCalledTimes(1);
    expect(controller.toggleCamera).toHaveBeenCalledTimes(1);
    unmount();
    show({ media: { muted: true, cameraOn: true, hasVideo: true } });
    const muted = screen.getByRole('button', { name: 'Silenciar micrófono' });
    const filming = screen.getByRole('button', { name: 'Encender cámara' });
    expect([muted.getAttribute('aria-pressed'), filming.getAttribute('aria-pressed')]).toEqual(['true', 'true']);
    expect(muted.querySelector('svg')!.getAttribute('class')).toContain('lucide-mic-off');
    expect(filming.querySelector('svg')!.getAttribute('class')).toContain('lucide-video ');
  });

  it('hangs up with PhoneOff on the danger colour', () => {
    const { controller } = show();
    const hangUp = screen.getByRole('button', { name: 'Colgar' });
    expect(hangUp.querySelector('svg')!.getAttribute('class')).toContain('lucide-phone-off');
    expect(hangUp.className).toContain('bg-ui-danger');
    expect(hangUp.className).toContain('text-ui-danger-bg');
    fireEvent.click(hangUp);
    expect(controller.hangup).toHaveBeenCalledTimes(1);
  });

  // David, 12 Oct 2026: the output's dropdown in the row of controls "quedó horrible". Each control is a
  // pill with its button and a chevron that opens a menu of its own devices, as in Zoom or Meet.
  it('chooses the microphone from the chevron beside it, with the one in use checked', () => {
    const { controller } = show(
      { media: { muted: false, cameraOn: false, hasVideo: false, microphoneId: 'usb' } },
      { devices: DEVICES },
    );
    const chevron = screen.getByRole('button', { name: 'Elegir micrófono' });
    expect(chevron.getAttribute('aria-haspopup')).toBe('menu');
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    expect(chevron.querySelector('svg')!.getAttribute('class')).toContain('lucide-chevron-up');
    fireEvent.click(chevron);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Elegir micrófono' })).toBeTruthy();
    expect(names(choices())).toEqual(['Predeterminado - Micrófono (Realtek)', 'Micrófono USB']);
    expect(checked()).toEqual(['Micrófono USB']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Predeterminado - Micrófono (Realtek)' }));
    expect(controller.selectMicrophone).toHaveBeenCalledWith('default');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the mute button beside the chevron, in the same pill', () => {
    const { controller } = show({}, { devices: DEVICES });
    const mute = screen.getByRole('button', { name: 'Silenciar micrófono' });
    const chevron = screen.getByRole('button', { name: 'Elegir micrófono' });
    expect(mute.closest('[data-call-pill]')).not.toBeNull();
    expect(mute.closest('[data-call-pill]')).toBe(chevron.closest('[data-call-pill]'));
    fireEvent.click(mute);
    expect(controller.toggleMute).toHaveBeenCalledTimes(1);
    expect(controller.selectMicrophone).not.toHaveBeenCalled();
  });

  it('chooses the camera from its chevron, without turning it on', () => {
    const { controller } = show(
      { media: { muted: false, cameraOn: false, hasVideo: false, cameraId: 'cam-1' } },
      { devices: DEVICES },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Elegir cámara' }));
    expect(names(choices())).toEqual(['Cámara integrada', 'Cámara USB']);
    expect(checked()).toEqual(['Cámara integrada']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Cámara USB' }));
    expect(controller.selectCamera).toHaveBeenCalledWith('cam-2');
    expect(controller.toggleCamera).not.toHaveBeenCalled();
  });

  it('chooses the audio output from the speaker, the system’s checked until another is chosen', () => {
    const { onSinkChange, unmount } = show({}, { devices: DEVICES });
    expect(screen.queryByRole('combobox')).toBeNull();
    const speaker = screen.getByRole('button', { name: 'Elegir salida de audio' });
    expect(speaker.getAttribute('aria-haspopup')).toBe('menu');
    expect(speaker.querySelector('svg.lucide-volume2')).not.toBeNull();
    fireEvent.click(speaker);
    expect(names(choices())).toEqual(['Predeterminado - Altavoces (Realtek(R) Audio)', 'Audífonos USB']);
    expect(checked()).toEqual(['Predeterminado - Altavoces (Realtek(R) Audio)']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Audífonos USB' }));
    expect(onSinkChange).toHaveBeenCalledWith('usb-out');
    unmount();
    show({}, { devices: DEVICES, sinkId: 'usb-out' });
    fireEvent.click(screen.getByRole('button', { name: 'Elegir salida de audio' }));
    expect(checked()).toEqual(['Audífonos USB']);
  });

  // Where the system cannot send the sound elsewhere (no setSinkId), useCallDevices lists no outputs.
  it('shows no speaker where the output cannot be chosen, and no chevron for a kind with no device', () => {
    show({}, { devices: { ...DEVICES, outputs: [], cameras: [] } });
    expect(screen.queryByRole('button', { name: 'Elegir salida de audio' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Elegir cámara' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Elegir micrófono' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Encender cámara' })).toBeTruthy();
  });

  it('names a device without a label by its kind and place', () => {
    show(
      {},
      {
        devices: {
          microphones: [device('audioinput', 'a', ''), device('audioinput', 'b', '')],
          outputs: [device('audiooutput', 'x', '')],
          cameras: [device('videoinput', 'c', '')],
        },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Elegir micrófono' }));
    expect(names(choices())).toEqual(['Micrófono 1', 'Micrófono 2']);
    // A press outside a menu closes it, as on the next chevron.
    const open = (name: string) => {
      const button = screen.getByRole('button', { name });
      fireEvent.mouseDown(button);
      fireEvent.click(button);
    };
    open('Elegir cámara');
    expect(names(choices())).toEqual(['Cámara 1']);
    open('Elegir salida de audio');
    expect(names(choices())).toEqual(['Salida 1']);
  });

  it('gives every chevron a 44 px target and draws its icons through iconSize', () => {
    show({}, { devices: DEVICES });
    for (const name of ['Elegir micrófono', 'Elegir cámara', 'Elegir salida de audio']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('min-h-11');
      expect(button.className).toContain('min-w-11');
      for (const icon of Array.from(button.querySelectorAll('svg'))) expect(icon.getAttribute('class')).toMatch(/size-\[/);
    }
  });

  it('says it when the chosen microphone could not be used, as an alert', () => {
    show({ notice: 'microphone' });
    expect(screen.getByRole('alert').textContent).toContain('No se pudo usar ese micrófono.');
  });

  it('goes back to the chat from its button, and from Escape', () => {
    const { controller } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Volver al chat' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Colgar' }), { key: 'Escape' });
    expect(controller.setMinimized).toHaveBeenCalledTimes(2);
    expect(controller.setMinimized).toHaveBeenCalledWith(true);
  });

  it('closes the comparison of symbols first on Escape', () => {
    const { controller } = show({ sas: { indices: INDICES, verified: false } });
    fireEvent.click(screen.getByRole('button', { name: /^Símbolos de la llamada/ }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Coinciden' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Coinciden' })).toBeNull();
    expect(controller.setMinimized).not.toHaveBeenCalled();
  });

  it('shows the other side’s video and this camera, without playing their sound twice', () => {
    const remote = { id: 'remote' } as unknown as MediaStream;
    const local = { id: 'local' } as unknown as MediaStream;
    show({ video: true, remoteStream: remote, localStream: local, media: { muted: false, cameraOn: true, hasVideo: true } });
    const theirs = screen.getByLabelText('Video de Ana Torres') as HTMLVideoElement;
    const mine = screen.getByLabelText('Tu cámara') as HTMLVideoElement;
    expect(theirs.srcObject).toBe(remote);
    expect(mine.srcObject).toBe(local);
    // The sound plays once, through CallMediaSink.
    expect(theirs.muted).toBe(true);
    expect(mine.muted).toBe(true);
  });

  it('says it when the camera failed, as an alert', () => {
    show({ notice: 'camera' });
    expect(screen.getByRole('alert').textContent).toContain('No se pudo usar la cámara.');
  });

  it('pulses around the avatar while it calls, never with reduced motion', () => {
    const { container, unmount } = show({ view: 'ringing-out' });
    const pulse = container.querySelector('[data-pulse]');
    expect(pulse?.getAttribute('class')).toContain('full-motion:animate-radar');
    expect(pulse?.getAttribute('class')).toContain('reduce-motion:hidden');
    unmount();
    const connected = show({ view: 'connected' });
    expect(connected.container.querySelector('[data-pulse]')).toBeNull();
  });
});
