/**
 * Settings > Avanzado (Settings:250-273, plan §1.5): the technical details,
 * kept out of the other sections (principle 4).
 *
 * - The relays with their real state (K3), read only, each with the icon
 *   and the word of ConnectionChip, never a coloured dot. Without K3 the
 *   list is left out. "Agregar relay" is not here: the relays are fixed.
 * - "Actividad de red", what the relays see of your messages.
 * - Your key, in capitals and groups of four.
 * - The line about trino-gui-debug.log only for a backend that writes it (after
 *   T3 a release build does not), and no switch that would lie about it.
 * - The version.
 */
import { Circle, CircleSlash } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConnectionStatus, ProfileResponse } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { Button, cx, iconSize } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { formatKey } from '../format-key';
import { NetworkActivityDialog } from '../NetworkActivityDialog';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi, SettingsCapabilities } from '../types';

export interface AdvancedSectionProps {
  api: Pick<SettingsApi, 'connectionStatus' | 'getVersion' | 'relayInspectStart' | 'relayInspectStop' | 'onRelayEvent'>;
  profile: ProfileResponse | null;
  capabilities: Pick<SettingsCapabilities, 'relayStatus' | 'diagnosticLog'>;
  autoFocus?: boolean;
}

const GROUP_TITLE = 'text-ui-lg font-bold text-ui-ink';

export function AdvancedSection({ api, profile, capabilities, autoFocus }: AdvancedSectionProps) {
  const t = useT();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [activity, setActivity] = useState(false);

  useEffect(() => {
    let live = true;
    if (capabilities.relayStatus) {
      api.connectionStatus().then(
        next => {
          if (live) setStatus(next);
        },
        () => {
          if (live) setStatusFailed(true);
        },
      );
    }
    api.getVersion().then(
      next => {
        if (live) setVersion(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, capabilities.relayStatus]);

  return (
    <SettingsSection title={t('settings2.advanced.title')} autoFocus={autoFocus}>
      {capabilities.relayStatus ? (
        <div className="flex flex-col gap-2 font-ui">
          <h3 className={cx('m-0', GROUP_TITLE)}>{t('settings2.advanced.relays')}</h3>
          {statusFailed ? <ErrorLine>{t('settings2.advanced.relaysError')}</ErrorLine> : null}
          {status ? (
            <ul role="list" aria-label={t('settings2.advanced.relays')} className="m-0 flex list-none flex-col gap-2 p-0">
              {status.relays.map(relay => {
                const Icon = relay.connected ? Circle : CircleSlash;
                return (
                  <li
                    key={relay.url}
                    className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-ui border border-ui-line px-3.5 py-2"
                  >
                    <Icon
                      {...iconSize('xs', cx('shrink-0', relay.connected ? 'text-ui-ok' : 'text-ui-danger'))}
                      aria-hidden="true"
                      data-icon={relay.connected ? 'circle' : 'circle-slash'}
                      fill={relay.connected ? 'currentColor' : 'none'}
                    />
                    <code className="min-w-0 flex-1 font-ui-mono text-ui-md text-ui-ink [overflow-wrap:anywhere]">
                      {relay.url}
                    </code>
                    <span className="text-ui-md text-ui-muted">
                      {t(relay.connected ? 'settings2.advanced.relayUp' : 'settings2.advanced.relayDown')}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col items-start gap-2 font-ui">
        <h3 className={cx('m-0', GROUP_TITLE)}>{t('settings2.advanced.activity')}</h3>
        <p className="m-0 text-ui-md text-ui-muted">{t('settings2.advanced.activityBody')}</p>
        <Button onClick={() => setActivity(true)}>{t('settings2.advanced.activityOpen')}</Button>
      </div>

      {profile ? (
        <div className="flex flex-col gap-1 font-ui">
          <h3 className={cx('m-0', GROUP_TITLE)}>{t('settings2.advanced.key')}</h3>
          <code className="font-ui-mono text-ui-lg tracking-[0.06em] text-ui-ink [overflow-wrap:anywhere]">
            {formatKey(profile.fingerprint)}
          </code>
        </div>
      ) : null}

      {capabilities.diagnosticLog ? (
        <p className="m-0 border-t border-ui-line pt-3.5 text-ui-md text-ui-muted">{t('settings2.advanced.log')}</p>
      ) : null}

      {version ? (
        <p className="m-0 text-ui-md text-ui-muted">{t('settings2.advanced.version', { version })}</p>
      ) : null}

      {activity ? (
        <NetworkActivityDialog api={api} myNostrPub={profile?.nostr_pub} onClose={() => setActivity(false)} />
      ) : null}
    </SettingsSection>
  );
}
