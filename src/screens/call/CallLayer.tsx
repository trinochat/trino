/**
 * Everything a call puts over the shell: the call screen, the incoming call,
 * the question of calling directly, the end card, the confirmation before
 * ending the call, and the sound, which stays mounted so a minimized call
 * keeps playing. The shell (W2) mounts `CallSlot.layer` in a positioned box
 * over its panes, below the title bar, and `CallSlot.bar` above both panes;
 * `callSlot` makes both from the controller.
 */
import { useState } from 'react';
import type { CallSlot } from '../types';
import { CallBar } from './CallBar';
import { CallEndedCard } from './CallEndedCard';
import { CallMediaSink, useAudioOutputs } from './CallMediaSink';
import { CallScreen } from './CallScreen';
import { useNow } from './call-view-model';
import { DirectCallConsentDialog } from './DirectCallConsentDialog';
import { EndCallConfirmDialog } from './EndCallConfirmDialog';
import { IncomingCallDialog } from './IncomingCallDialog';
import type { CallController } from './useCallController';

export interface CallLayerProps {
  controller: CallController;
}

export function CallLayer({ controller: call }: CallLayerProps) {
  const [sinkId, setSinkId] = useState<string>();
  const outputs = useAudioOutputs(call.activePeer !== null);
  const inProgress = call.view === 'ringing-out' || call.view === 'connecting' || call.view === 'connected';
  return (
    <>
      <CallMediaSink stream={call.remoteStream} sinkId={sinkId} />
      {inProgress && !call.minimized && (
        <CallScreen controller={call} outputs={outputs} sinkId={sinkId} onSinkChange={setSinkId} />
      )}
      <IncomingCallDialog
        open={call.view === 'incoming'}
        name={call.peer?.name ?? ''}
        avatar={call.peer?.avatar ?? null}
        video={call.video}
        verified={call.peer?.verified === true}
        onAnswer={call.accept}
        onDecline={call.reject}
      />
      <DirectCallConsentDialog
        consent={call.consent}
        peerName={call.consent ? call.nameOf(call.consent.peer) : ''}
        onAnswer={call.answerConsent}
      />
      <CallEndedCard card={call.view === 'ended' ? call.ended : null} onCallAgain={call.callAgain} onClose={call.dismissEnded} />
      <EndCallConfirmDialog reason={call.endConfirm} onAnswer={call.answerEndConfirm} />
    </>
  );
}

/** The bar of a minimized call, ticking its time. */
export function ActiveCallBar({ controller: call }: CallLayerProps) {
  const now = useNow(call.connectedAt !== null);
  return (
    <CallBar
      peerName={call.peer?.name ?? ''}
      connectedAt={call.connectedAt}
      now={now}
      ringing={call.view === 'ringing-out'}
      muted={call.media.muted}
      onToggleMute={call.toggleMute}
      onHangUp={call.hangup}
      onReturn={() => call.setMinimized(false)}
    />
  );
}

/** The call as the shell takes it (types.ts): the bar only while a call is minimized. */
export function callSlot(call: CallController): CallSlot {
  const inCall = call.activePeer !== null && call.view !== 'incoming';
  return {
    bar: call.minimized && inCall ? <ActiveCallBar controller={call} /> : null,
    layer: <CallLayer controller={call} />,
    start: call.start,
    activePeer: call.activePeer,
  };
}
