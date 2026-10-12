/**
 * Calls (W6): the controller over call.ts and the screens it feeds. The
 * integration (I5) creates the controller with `useCallController(deps)`
 * and gives the shell `callSlot(controller)`; while the slot is `covering`
 * (`callCoversShell(controller)`), the shell makes its panes inert.
 */
export {
  useCallController,
  type CallAlerts,
  type CallController,
  type CallControllerDeps,
  type CallEndCard,
  type CallEngine,
  type CallNotice,
  type CallPeer,
  type CallSas,
  type CallSounds,
  type EndConfirmReason,
} from './useCallController';
export { ActiveCallBar, CallLayer, callCoversShell, callSlot, type CallLayerProps } from './CallLayer';
export { CallBar, type CallBarProps } from './CallBar';
export { CallScreen, type CallScreenProps } from './CallScreen';
export { CallEndedCard, type CallEndedCardProps } from './CallEndedCard';
export { CallMediaSink, canChooseOutput, useCallDevices, type CallDevices, type CallMediaSinkProps } from './CallMediaSink';
export { ConnectionModeLine, type ConnectionModeLineProps } from './ConnectionModeLine';
export { DirectCallConsentDialog, type DirectCallConsentDialogProps } from './DirectCallConsentDialog';
export { EndCallConfirmDialog, type EndCallConfirmDialogProps } from './EndCallConfirmDialog';
export { IncomingCallDialog, type IncomingCallDialogProps } from './IncomingCallDialog';
export { SasKey, type SasKeyProps } from './SasKey';
export { callOutcome, MAX_CALL_SECONDS, type CallRecord, type CallTrace, type LocalEnd } from './call-outcome';
export { callClock, endReasonOf, useNow, viewOf, type CallEndReason, type CallView } from './call-view-model';
