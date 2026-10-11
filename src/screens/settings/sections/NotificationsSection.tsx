/**
 * Settings > Notificaciones (Settings:50-113, plan §1.5): what a message
 * notification shows, with a preview and "Probar notificación"; the message
 * sound, calls with the window closed and muted groups; the ringtone,
 * "Suave" or "Silencio" ("Campana" does not exist), and its volume; and, on
 * Windows only, starting with Windows. Each choice is kept in the device's
 * preferences, where the notifier and the sounds (W6) read it.
 *
 * The preview has no avatar: the picture of a Windows notification is not
 * verified, so a real one never shows it (notification-content.ts).
 */
import { useEffect, useId, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { NOTIF_PREVIEWS, RINGTONES, type NotifPreview, type Prefs, type Ringtone } from '../../../lib/prefs';
import { Button, cx, RadioCardGroup, Select, Switch } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { notificationContent } from '../notification-content';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi, SettingsPlatform } from '../types';

export interface NotificationsSectionProps {
  api: Pick<SettingsApi, 'notify' | 'getAutostart' | 'setAutostart'>;
  prefs: Prefs;
  platform: SettingsPlatform;
  autoFocus?: boolean;
}

const LEVEL_KEYS: Record<NotifPreview, string> = {
  full: 'settings2.notif.full',
  name: 'settings2.notif.name',
  none: 'settings2.notif.none',
};
const RINGTONE_KEYS: Record<Ringtone, string> = { soft: 'settings2.notif.ringSoft', silent: 'settings2.notif.ringSilent' };

/** The theme's label style, as Settings:67 draws "Vista previa". */
const LABEL =
  'font-ui-label text-ui-sm font-semibold text-ui-muted [letter-spacing:var(--t-label-spacing)] [text-transform:var(--t-label-transform)]';

/** A row of the list of switches: a line under each, as in the board. */
const ROW = 'border-b border-ui-line py-3.5';

export function NotificationsSection({ api, prefs, platform, autoFocus }: NotificationsSectionProps) {
  const t = useT();
  const [level, setLevel] = useState<NotifPreview>(() => prefs.getNotifPreview());
  const [messageSound, setMessageSound] = useState(() => prefs.getMessageSound());
  const [callsHidden, setCallsHidden] = useState(() => prefs.getCallNotifyHidden());
  const [muteGroups, setMuteGroups] = useState(() => prefs.getMuteGroupsByDefault());
  const [ringtone, setRingtone] = useState<Ringtone>(() => prefs.getRingtone());
  const [volume, setVolume] = useState(() => prefs.getRingVolume());
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartFailed, setAutostartFailed] = useState(false);
  const toneId = useId();
  const volumeId = useId();
  const onWindows = platform === 'windows';

  useEffect(() => {
    if (!onWindows) return;
    let live = true;
    api.getAutostart().then(
      on => {
        if (live) setAutostart(on);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, onWindows]);

  const sample = notificationContent(
    level,
    { title: t('settings2.notif.sampleName'), text: t('settings2.notif.sampleText'), kind: 'text' },
    t,
  );

  const toggleAutostart = async (on: boolean) => {
    setAutostart(on);
    setAutostartFailed(false);
    try {
      await api.setAutostart(on);
    } catch {
      setAutostart(!on);
      setAutostartFailed(true);
    }
  };

  return (
    <SettingsSection title={t('settings2.notif.title')} autoFocus={autoFocus}>
      <RadioCardGroup
        label={t('settings2.notif.level')}
        value={level}
        onValueChange={value => {
          setLevel(value);
          prefs.setNotifPreview(value);
        }}
        options={NOTIF_PREVIEWS.map(value => ({
          value,
          label: t(LEVEL_KEYS[value]),
          description: t(`${LEVEL_KEYS[value]}Body`),
        }))}
      />

      <div className="flex flex-col gap-2">
        <span aria-hidden="true" className={LABEL}>
          {t('settings2.notif.preview')}
        </span>
        <div
          role="group"
          aria-label={t('settings2.notif.previewA11y')}
          className="flex w-full max-w-[26.25rem] flex-col gap-2.5 rounded-ui border border-ui-line bg-ui-raised px-3.5 py-3 font-ui"
        >
          <span className="flex items-center gap-2 text-ui-xs text-ui-muted">
            <span className="min-w-0 flex-1">{t('settings2.notif.appName')}</span>
            <span>{t('time2.justNow')}</span>
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui-base font-semibold text-ui-ink">{sample.title}</span>
            <span className="truncate text-ui-md text-ui-muted">{sample.body}</span>
          </span>
        </div>
        <Button className="self-start" onClick={() => void api.notify(sample.title, sample.body)}>
          {t('settings2.notif.test')}
        </Button>
      </div>

      <div className="flex flex-col border-t border-ui-line">
        <Switch
          className={ROW}
          label={t('settings2.notif.sound')}
          description={t('settings2.notif.soundBody')}
          checked={messageSound}
          onCheckedChange={on => {
            setMessageSound(on);
            prefs.setMessageSound(on);
          }}
        />
        <Switch
          className={ROW}
          label={t('settings2.notif.callsHidden')}
          description={t('settings2.notif.callsHiddenBody')}
          checked={callsHidden}
          onCheckedChange={on => {
            setCallsHidden(on);
            prefs.setCallNotifyHidden(on);
          }}
        />
        <Switch
          className={ROW}
          label={t('settings2.notif.muteGroups')}
          description={t('settings2.notif.muteGroupsBody')}
          checked={muteGroups}
          onCheckedChange={on => {
            setMuteGroups(on);
            prefs.setMuteGroupsByDefault(on);
          }}
        />
        <div className={cx('flex flex-wrap items-center gap-4', ROW)}>
          <span className="flex min-w-0 flex-[1_1_12.5rem] flex-col gap-0.5 font-ui">
            <label htmlFor={toneId} className="text-ui-base font-semibold text-ui-ink">
              {t('settings2.notif.ringtone')}
            </label>
            <span id={`${toneId}-body`} className="text-ui-md text-ui-muted">
              {t('settings2.notif.ringtoneBody')}
            </span>
          </span>
          <Select
            id={toneId}
            aria-describedby={`${toneId}-body`}
            value={ringtone}
            onChange={event => {
              const value = event.target.value as Ringtone;
              setRingtone(value);
              prefs.setRingtone(value);
            }}
          >
            {RINGTONES.map(value => (
              <option key={value} value={value}>
                {t(RINGTONE_KEYS[value])}
              </option>
            ))}
          </Select>
          <label htmlFor={volumeId} className="sr-only">
            {t('settings2.notif.volume')}
          </label>
          <input
            id={volumeId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            disabled={ringtone === 'silent'}
            aria-valuetext={t('settings2.notif.volumeValue', { n: volume })}
            onChange={event => {
              const value = Number(event.target.value);
              setVolume(value);
              prefs.setRingVolume(value);
            }}
            className="min-h-11 w-40 cursor-pointer accent-ui-accent disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        {onWindows && autostart !== null ? (
          <Switch
            className={ROW}
            label={t('settings2.notif.autostart')}
            description={t('settings2.notif.autostartBody')}
            checked={autostart}
            onCheckedChange={on => void toggleAutostart(on)}
          />
        ) : null}
      </div>
      {autostartFailed ? <ErrorLine>{t('settings2.notif.errAutostart')}</ErrorLine> : null}
    </SettingsSection>
  );
}
