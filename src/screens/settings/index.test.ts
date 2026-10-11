import { describe, expect, it } from 'vitest';
import * as settings from './index';

// What the integration takes from Settings (plan §4: I2 mounts the screen,
// I6's notifier uses notificationContent).
describe('the settings module', () => {
  it('exports the screen and the helpers the integration uses', () => {
    expect(Object.keys(settings).sort()).toEqual(['SettingsScreen', 'formatKey', 'notificationContent']);
  });
});
