/**
 * The screens before the chats (W1, plan §3): reading the status, the first
 * run, the unlock screen and the window's title bar, with the phase that
 * picks between them. The integration imports them from here, never from the
 * files behind.
 */
export { phaseReducer, INITIAL_PHASE, type AppPhase, type PhaseEvent } from './app-phase';
export { AuthFrame, type AuthFrameProps } from './common/AuthFrame';
export { WindowTitlebar, type WindowApi, type WindowTitlebarProps } from './chrome/WindowTitlebar';
export { StartupScreen, type StartupScreenOptions, type StartupScreenProps } from './startup/StartupScreen';
export { OnboardingFlow, type OnboardingFlowOptions } from './onboarding/OnboardingFlow';
export {
  CONSENT_STORAGE_KEY,
  PRIVACY_POLICY_URL,
  PRIVACY_POLICY_VERSION,
  loadConsentRecord,
  type ConsentRecord,
  type ConsentStorage,
} from './onboarding/consent';
export { UnlockScreen } from './unlock/UnlockScreen';
