// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallMediaSink, useCallDevices } from './CallMediaSink';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
});

const stream = (name: string) => ({ id: name }) as unknown as MediaStream;
const audio = () => document.querySelector('audio')!;

describe('CallMediaSink', () => {
  it('plays the other side through one audio element that stays mounted', () => {
    const first = stream('a');
    const { rerender } = render(<CallMediaSink stream={first} />);
    const element = audio();
    expect(element.srcObject).toBe(first);
    expect(element.autoplay).toBe(true);
    const second = stream('b');
    rerender(<CallMediaSink stream={second} />);
    expect(audio()).toBe(element);
    expect(element.srcObject).toBe(second);
    rerender(<CallMediaSink stream={null} />);
    expect(element.srcObject).toBeNull();
  });

  it('sends the sound to the chosen output when the system lets it', async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: setSinkId, configurable: true, writable: true });
    const { rerender } = render(<CallMediaSink stream={stream('a')} />);
    expect(setSinkId).not.toHaveBeenCalled();
    rerender(<CallMediaSink stream={stream('a')} sinkId="usb" />);
    expect(setSinkId).toHaveBeenCalledWith('usb');
  });
});

describe('useCallDevices', () => {
  function devices(list: Array<Partial<MediaDeviceInfo>>) {
    const listeners = new Set<() => void>();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => list as MediaDeviceInfo[]),
      addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
      removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
    };
    vi.stubGlobal('navigator', { mediaDevices });
    return { mediaDevices, listeners, list };
  }

  const DEVICES = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Predeterminado - Parlantes (Realtek)' },
    { kind: 'audioinput', deviceId: 'default', label: 'Predeterminado - Micrófono (Realtek)' },
    { kind: 'audioinput', deviceId: 'usb', label: 'Micrófono USB' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Cámara integrada' },
    { kind: 'audiooutput', deviceId: 'usb-out', label: 'Audífonos USB' },
  ] as const;

  const labels = (list: readonly MediaDeviceInfo[]) => list.map(d => d.label);

  it('lists the microphones, the audio outputs and the cameras while a call is on', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: vi.fn(), configurable: true, writable: true });
    const { mediaDevices } = devices([...DEVICES]);
    const { result } = renderHook(() => useCallDevices(true));
    await waitFor(() =>
      expect(labels(result.current.microphones)).toEqual(['Predeterminado - Micrófono (Realtek)', 'Micrófono USB']),
    );
    expect(labels(result.current.outputs)).toEqual(['Predeterminado - Parlantes (Realtek)', 'Audífonos USB']);
    expect(labels(result.current.cameras)).toEqual(['Cámara integrada']);
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
  });

  it('lists no outputs where the output cannot be chosen, and still the microphones and cameras', async () => {
    devices([...DEVICES]);
    const { result } = renderHook(() => useCallDevices(true));
    await waitFor(() => expect(result.current.microphones).toHaveLength(2));
    expect(result.current.outputs).toEqual([]);
    expect(result.current.cameras).toHaveLength(1);
  });

  // Before the permission of its kind, Chromium lists a device with an empty id: nothing to choose.
  it('leaves out the devices it cannot name by id', async () => {
    devices([...DEVICES, { kind: 'videoinput', deviceId: '', label: '' }]);
    const { result } = renderHook(() => useCallDevices(true));
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
  });

  it('follows a device that comes or goes, and asks again when the call opens its media', async () => {
    const { mediaDevices, listeners, list } = devices([...DEVICES]);
    const { result, rerender } = renderHook(({ key }) => useCallDevices(true, key), { initialProps: { key: 'a' } });
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
    (list as Array<Partial<MediaDeviceInfo>>).push({ kind: 'videoinput', deviceId: 'cam-2', label: 'Cámara USB' });
    act(() => listeners.forEach(fn => fn()));
    await waitFor(() => expect(labels(result.current.cameras)).toEqual(['Cámara integrada', 'Cámara USB']));
    const asked = mediaDevices.enumerateDevices.mock.calls.length;
    rerender({ key: 'b' });
    await waitFor(() => expect(mediaDevices.enumerateDevices.mock.calls.length).toBeGreaterThan(asked));
  });

  it('lists nothing without a call, and stops listening after it', async () => {
    const { mediaDevices, listeners } = devices([...DEVICES]);
    const { result, rerender } = renderHook(({ on }) => useCallDevices(on), { initialProps: { on: false } });
    expect(result.current.microphones).toEqual([]);
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.microphones).toHaveLength(2));
    rerender({ on: false });
    expect(listeners.size).toBe(0);
    expect(result.current.microphones).toEqual([]);
    expect(result.current.cameras).toEqual([]);
  });
});
