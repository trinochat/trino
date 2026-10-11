/**
 * The call in progress (Call:81-164): the contact, the time and how the call
 * travels; the stage with the avatar or the video, and the key of the call
 * at its top; and the controls. No quality bars: there is no measure of the
 * quality yet (plan §1.6). "Volver al chat" (and Escape) minimizes the call
 * to its bar (plan §1.8, deviation 5); the sound goes on through
 * CallMediaSink, so the videos here are muted.
 *
 * CallLayer lays it over the shell's area and passes the audio outputs.
 */
import { Mic, MicOff, Minimize2, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { identityInitials } from '../../lib/initials';
import { useT } from '../../lib/i18n';
import { Avatar, Banner, IconButton, Select, iconSize } from '../../ui';
import { callClock, useNow } from './call-view-model';
import { ConnectionModeLine } from './ConnectionModeLine';
import { CallToggle, HangUpButton } from './controls';
import { SasKey } from './SasKey';
import type { CallController } from './useCallController';

export interface CallScreenProps {
  controller: CallController;
  /** The audio outputs to choose from; the choice shows only with more than one. */
  outputs: readonly MediaDeviceInfo[];
  sinkId: string | undefined;
  onSinkChange(deviceId: string): void;
}

export function CallScreen({ controller: call, outputs, sinkId, onSinkChange }: CallScreenProps) {
  const t = useT();
  const now = useNow(call.connectedAt !== null);
  const name = call.peer?.name ?? '';
  const ringing = call.view === 'ringing-out';
  const status =
    call.view === 'connected' && call.connectedAt !== null
      ? callClock(call.connectedAt, now)
      : t(call.view === 'connecting' ? 'call2.screen.connecting' : 'call2.screen.calling');

  const theirVideo = useRef<HTMLVideoElement>(null);
  const myVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (theirVideo.current) theirVideo.current.srcObject = call.remoteStream;
  }, [call.remoteStream, call.video]);
  // The preview unmounts while the camera is off: attach the stream when it mounts again.
  useEffect(() => {
    if (myVideo.current) myVideo.current.srcObject = call.localStream;
  }, [call.localStream, call.media.hasVideo]);

  const portrait = (
    <div className="flex flex-1 items-center justify-center p-4">
      {!call.video && (
        <span className="relative inline-flex">
          {ringing && (
            <span
              data-pulse=""
              aria-hidden="true"
              className="absolute inset-0 hidden rounded-ui-avatar border-2 border-ui-accent-text full-motion:block full-motion:animate-radar reduce-motion:hidden"
            />
          )}
          <Avatar initials={identityInitials(name)} src={call.peer?.avatar ?? undefined} size={96} />
        </span>
      )}
    </div>
  );

  return (
    <section
      aria-label={t('call2.screen.label', { name })}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        call.setMinimized(true);
      }}
      className="absolute inset-0 z-30 flex overflow-y-auto bg-ui-bg p-4 font-ui text-ui-ink [background-image:var(--t-scan)]"
    >
      <div className="m-auto flex min-h-[min(100%,30.5rem)] w-full max-w-[47.5rem] flex-col gap-5 rounded-ui-lg border border-ui-line bg-ui-surface p-6 [box-shadow:var(--t-shadow)]">
        <header className="flex flex-wrap items-center gap-3">
          <Avatar initials={identityInitials(name)} src={call.peer?.avatar ?? undefined} size={44} />
          <div className="flex min-w-0 flex-[1_1_12.5rem] flex-col gap-0.5">
            <h2 className="m-0 font-ui-display text-[1.125rem] font-bold leading-tight [overflow-wrap:anywhere]">{name}</h2>
            <div className="flex flex-wrap items-center gap-x-1.5 text-ui-md text-ui-muted">
              <span className="font-ui-mono">{status}</span>
              <ConnectionModeLine mode={call.mode} ringing={ringing} />
            </div>
          </div>
          <IconButton
            aria-label={t('call2.screen.back')}
            icon={<Minimize2 {...iconSize('lg')} />}
            onClick={() => call.setMinimized(true)}
          />
        </header>

        <div className="relative flex flex-[1_0_14.375rem] flex-col overflow-hidden rounded-ui bg-ui-raised">
          {call.video && (
            <video
              ref={theirVideo}
              autoPlay
              playsInline
              muted
              aria-label={t('call2.screen.remoteVideo', { name })}
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {call.sas ? (
            <SasKey sas={call.sas} peerName={name} onMatch={call.confirmMatch}>
              {portrait}
            </SasKey>
          ) : (
            portrait
          )}
          {call.media.hasVideo && (
            <video
              ref={myVideo}
              autoPlay
              playsInline
              muted
              aria-label={t('call2.screen.localVideo')}
              className="absolute bottom-3 right-3 z-10 w-28 rounded-ui border border-ui-line object-cover"
            />
          )}
        </div>

        {call.notice === 'camera' && <Banner tone="danger">{t('call2.screen.cameraError')}</Banner>}

        <div role="group" aria-label={t('call2.screen.controls')} className="flex flex-wrap items-center justify-center gap-3">
          <CallToggle
            label={t('call2.screen.mute')}
            pressed={call.media.muted}
            icons={{ pressed: MicOff, idle: Mic }}
            size="screen"
            onClick={call.toggleMute}
          />
          <CallToggle
            label={t('call2.screen.camera')}
            pressed={call.media.cameraOn}
            icons={{ pressed: Video, idle: VideoOff }}
            size="screen"
            onClick={call.toggleCamera}
          />
          {outputs.length > 1 && (
            <Select
              aria-label={t('call2.screen.output')}
              value={sinkId ?? outputs[0]!.deviceId}
              onChange={event => onSinkChange(event.target.value)}
              className="max-w-full"
            >
              {outputs.map((device, i) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || t('call2.screen.outputUnnamed', { n: i + 1 })}
                </option>
              ))}
            </Select>
          )}
          <HangUpButton label={t('call2.screen.hangup')} size="screen" onClick={call.hangup} />
        </div>
      </div>
    </section>
  );
}
