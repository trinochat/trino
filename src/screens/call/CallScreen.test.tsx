// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sasWords } from '../../lib/sas-symbols';
import { CallScreen, type CallScreenProps } from './CallScreen';
import { fakeController, renderIn } from './test-support';
import type { CallController } from './useCallController';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const INDICES = [0, 44, 12, 43, 27, 37, 42];

function show(over: Partial<CallController> = {}, props: Partial<CallScreenProps> = {}) {
  const controller = fakeController(over);
  const onSinkChange = vi.fn();
  const view = renderIn(
    <CallScreen controller={controller} outputs={[]} sinkId={undefined} onSinkChange={onSinkChange} {...props} />,
  );
  return { ...view, controller, onSinkChange };
}

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
    rerender(<CallScreen controller={{ ...controller, view: 'connecting' }} outputs={[]} sinkId={undefined} onSinkChange={() => {}} />);
    expect(callScreen().textContent).toContain('Conectando…');
    rerender(
      <CallScreen
        controller={{ ...controller, view: 'connected', connectedAt: 1_000_000 - 201_000 }}
        outputs={[]}
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

  it('chooses the audio output only among more than one, by their real names', () => {
    const speakers = { deviceId: 'default', kind: 'audiooutput', label: 'Parlantes (Realtek)' } as MediaDeviceInfo;
    const headphones = { deviceId: 'usb', kind: 'audiooutput', label: 'Audífonos USB' } as MediaDeviceInfo;
    const { unmount } = show({}, { outputs: [speakers] });
    expect(screen.queryByRole('combobox')).toBeNull();
    unmount();
    const { onSinkChange } = show({}, { outputs: [speakers, headphones] });
    const output = screen.getByRole('combobox', { name: 'Salida de audio' }) as HTMLSelectElement;
    expect(Array.from(output.options, option => option.textContent)).toEqual(['Parlantes (Realtek)', 'Audífonos USB']);
    fireEvent.change(output, { target: { value: 'usb' } });
    expect(onSinkChange).toHaveBeenCalledWith('usb');
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
