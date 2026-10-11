// @vitest-environment jsdom
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallMediaSink, useAudioOutputs } from './CallMediaSink';

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

describe('useAudioOutputs', () => {
  function devices(list: Array<Partial<MediaDeviceInfo>>) {
    const listeners = new Set<() => void>();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => list as MediaDeviceInfo[]),
      addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
      removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
    };
    vi.stubGlobal('navigator', { mediaDevices });
    return { mediaDevices, listeners };
  }

  const OUTPUTS = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Parlantes (Realtek)' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Micrófono' },
    { kind: 'audiooutput', deviceId: 'usb', label: 'Audífonos USB' },
  ] as const;

  it('lists the real audio outputs while a call is on, when the output can be chosen', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: vi.fn(), configurable: true, writable: true });
    const { mediaDevices } = devices([...OUTPUTS]);
    const { result } = renderHook(() => useAudioOutputs(true));
    await waitFor(() => expect(result.current.map(d => d.label)).toEqual(['Parlantes (Realtek)', 'Audífonos USB']));
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
  });

  it('lists nothing where the output cannot be chosen', async () => {
    const { mediaDevices } = devices([...OUTPUTS]);
    const { result } = renderHook(() => useAudioOutputs(true));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.current).toEqual([]);
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  });

  it('lists nothing without a call, and stops listening after it', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: vi.fn(), configurable: true, writable: true });
    const { mediaDevices, listeners } = devices([...OUTPUTS]);
    const { result, rerender } = renderHook(({ on }) => useAudioOutputs(on), { initialProps: { on: false } });
    expect(result.current).toEqual([]);
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current).toHaveLength(2));
    rerender({ on: false });
    expect(listeners.size).toBe(0);
    expect(result.current).toEqual([]);
  });
});
