/**
 * The sound of a call. One `<audio>` element plays the other side, mounted
 * by CallLayer for as long as the app is, so the sound goes on while the
 * call is minimized to its bar or its screen is closed. The call screen's
 * videos are muted: the sound plays only here.
 *
 * Where the system lets the app choose (`setSinkId`), the call screen offers
 * the outputs by their real names in the speaker's menu (`useCallDevices`),
 * and the sound goes to the one chosen.
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

/** The devices a call can use, each kind in the order the system lists them. */
export interface CallDevices {
  microphones: MediaDeviceInfo[];
  /** Empty where the output cannot be chosen (no `setSinkId`). */
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

const NONE: CallDevices = { microphones: [], outputs: [], cameras: [] };

/**
 * The microphones, audio outputs and cameras while `active` (a call is on),
 * for the call screen's menus, kept up to date when a device comes or goes.
 * A device with no id is left out: Chromium lists one per kind before that
 * kind's permission, and there is nothing to choose in it. The names come
 * with the permission too, so a change of `refresh` (the call opening its
 * microphone or camera) asks the system again.
 */
export function useCallDevices(active: boolean, refresh?: unknown): CallDevices {
  const [devices, setDevices] = useState<CallDevices>(NONE);
  useEffect(() => {
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!active || !media?.enumerateDevices) {
      setDevices(NONE);
      return;
    }
    let current = true;
    const load = () => {
      media
        .enumerateDevices()
        .then(list => {
          if (!current) return;
          const of = (kind: MediaDeviceKind) => list.filter(device => device.kind === kind && device.deviceId !== '');
          setDevices({
            microphones: of('audioinput'),
            outputs: canChooseOutput() ? of('audiooutput') : [],
            cameras: of('videoinput'),
          });
        })
        .catch(() => {
          if (current) setDevices(NONE);
        });
    };
    load();
    media.addEventListener?.('devicechange', load);
    return () => {
      current = false;
      media.removeEventListener?.('devicechange', load);
    };
  }, [active, refresh]);
  return devices;
}
