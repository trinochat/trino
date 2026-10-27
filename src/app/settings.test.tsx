// @vitest-environment jsdom
import { getVersion } from '@tauri-apps/api/app';
import { describe, expect, it } from 'vitest';
import { api, onEmergencyAlert, onRelayEvent } from '../lib/api';
import { appWindow } from './capture-protection';
import { platformOf, settingsBackend } from './settings';

// What Settings (W5) takes from the app. How the chats mount it, in the
// shell's main pane, is src/app/MainScreen.test.tsx.

describe('platformOf', () => {
  it.each([
    ['windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'],
    ['macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
    ['linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'],
    ['linux', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'],
    ['macos', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'],
  ])('reads %s from the webview of %s', (platform, userAgent) => {
    expect(platformOf(userAgent)).toBe(platform);
  });
});

describe('settingsBackend', () => {
  it('is the app’s backend: src/lib/api.ts and the version Tauri gives', () => {
    const fromApi = [
      'getProfile',
      'updateProfile',
      'status',
      'totpBegin',
      'totpVerify',
      'totpEnable',
      'totpDisable',
      'changePassphrase',
      'setEmergencyKey',
      'testEmergencyKey',
      'removeEmergencyKey',
      'emergencyNetwork',
      'saveEmergencyNetwork',
      'refreshEmergencyNetwork',
      'wipe',
      'getAutostart',
      'setAutostart',
      'connectionStatus',
      'relayInspectStart',
      'relayInspectStop',
      'listNodes',
      'blockNode',
      // Privacidad › Bloqueados (UR-2).
      'listBlocked',
      'unblockIdentity',
      // Privacidad › Solicitudes eliminadas (UR-4).
      'listDeletedRequests',
      'undoDeletedRequest',
      // Privacidad › Reportes enviados (UR-5).
      'listSentReports',
      'cancelReport',
      'shareBundle',
      'testNotification',
    ] as const;
    for (const key of fromApi) expect(settingsBackend[key], key).toBe(api[key]);
    expect(settingsBackend.onRelayEvent).toBe(onRelayEvent);
    // "Qué pasa en la red" follows the contact's answer (CE-6b).
    expect(settingsBackend.onEmergencyAlert).toBe(onEmergencyAlert);
    expect(settingsBackend.getVersion).toBe(getVersion);
    // The switch of Settings › Privacidad changes the window itself (SC-1).
    expect(settingsBackend.setContentProtected).toBe(appWindow.setContentProtected);
    // Nothing more and nothing less than Settings asks for.
    expect(Object.keys(settingsBackend).sort()).toEqual([...fromApi, 'onRelayEvent', 'onEmergencyAlert', 'getVersion', 'setContentProtected'].sort());
  });
});
