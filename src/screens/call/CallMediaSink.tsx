/**
 * The sound of a call. One `<audio>` element plays the other side, mounted
 * by CallLayer for as long as the app is, so the sound goes on while the
 * call is minimized to its bar or its screen is closed. The call screen's
 * videos are muted: the sound plays only here.
 *
 * Where the system lets the app choose (`setSinkId`) and there is more than
 * one output, the call screen offers them by their real names
 * (`useAudioOutputs`), and the sound goes to the one chosen.
 */
import { useEffect, useRef, useState } from 'react';

export interface CallMediaSinkProps {
  stream: MediaStream | null;
  /** The audio output's device id; left out, the system's. */
  sinkId?: string;
}

type SinkAudio = HTMLAudioElement & { setSinkId?(id: string): Promise<void> };

export function CallMediaSink({ stream, sinkId }: CallMediaSinkProps) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    const audio = ref.current as SinkAudio | null;
    if (!audio || sinkId === undefined || typeof audio.setSinkId !== 'function') return;
    audio.setSinkId(sinkId).catch(error => console.error('audio output not set', error));
  }, [sinkId]);
  return <audio ref={ref} autoPlay data-call-sound="" />;
}

/** Whether the app can send a call's sound to an output of its choice. */
export function canChooseOutput(): boolean {
  return (
    typeof HTMLMediaElement !== 'undefined' &&
    typeof (HTMLMediaElement.prototype as SinkAudio).setSinkId === 'function'
  );
}

/**
 * The audio outputs while `active` (a call is on), kept up to date when a
 * device comes or goes; none where the output cannot be chosen.
 */
export function useAudioOutputs(active: boolean): MediaDeviceInfo[] {
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!active || !canChooseOutput() || !devices?.enumerateDevices) {
      setOutputs([]);
      return;
    }
    let current = true;
    const load = () => {
      devices
        .enumerateDevices()
        .then(list => {
          if (current) setOutputs(list.filter(device => device.kind === 'audiooutput'));
        })
        .catch(() => {
          if (current) setOutputs([]);
        });
    };
    load();
    devices.addEventListener?.('devicechange', load);
    return () => {
      current = false;
      devices.removeEventListener?.('devicechange', load);
    };
  }, [active]);
  return outputs;
}
