/**
 * Settings > Cuenta y seguridad (Settings:173-197, PropAjustes:223, plan
 * §1.5): your password, two-step verification, the auto-lock, locking now
 * and, apart and in red, erasing everything from this device.
 *
 * A control the backend cannot back yet is hidden, never faked: without K6
 * there is no "Cambiar contraseña", and without K5 two-step verification
 * only says whether it is on. "Nunca se bloquea durante una llamada" and
 * Ctrl + L hold because the shell keeps them (useAutoLock, the shortcut).
 *
 * "Clave de emergencia" (CE-5, design §8) is a row that opens its own page
 * (src/screens/settings/emergency/), the same for everyone (CE-D6): it
 * never says whether a key is set.
 */
import { KeyRound, Lock } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../../../lib/i18n';
import type { Prefs } from '../../../lib/prefs';
import { Button, iconSize, Select } from '../../../ui';
import { ChangePassphraseDialog } from '../ChangePassphraseDialog';
import { EmergencyKeyView } from '../emergency/EmergencyKeyView';
import { SettingsRows } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import { TotpDialog } from '../TotpDialog';
import type { SettingsApi, SettingsCapabilities, SettingsPlatform } from '../types';
import { WipeDialog } from '../WipeDialog';

export interface SecuritySectionProps {
  api: Pick<
    SettingsApi,
    | 'status'
    | 'totpBegin'
    | 'totpVerify'
    | 'totpEnable'
    | 'totpDisable'
    | 'changePassphrase'
    | 'wipe'
    | 'setEmergencyKey'
    | 'testEmergencyKey'
    | 'removeEmergencyKey'
    | 'emergencyNetwork'
    | 'saveEmergencyNetwork'
    | 'refreshEmergencyNetwork'
    | 'onEmergencyAlert'
    | 'listNodes'
  >;
  prefs: Prefs;
  capabilities: Pick<SettingsCapabilities, 'totp' | 'changePassphrase' | 'emergencyKey'>;
  /** Protección reforzada, suggested by the emergency key, is on Windows only. */
  platform?: SettingsPlatform;
  /** Opens Settings › Privacidad, where Protección reforzada is. */
  onOpenReinforced?(): void;
  /** Your name, for the account in the authenticator app. */
  identityName: string;
  onLockNow(): void;
  onIdentityWiped(): void;
  onAutolockChanged(minutes: number): void;
  autoFocus?: boolean;
}

/** Minutes; 0 never locks. */
const AUTOLOCK_CHOICES = [0, 1, 5, 15, 30, 60] as const;

type OpenDialog = 'totp' | 'passphrase' | 'wipe' | null;

const ROW = 'flex flex-wrap items-center gap-3 border-b border-ui-line py-3.5';
const ROW_TEXT = 'flex min-w-0 flex-[1_1_15rem] flex-col gap-0.5 font-ui';
const ROW_TITLE = 'text-ui-base font-semibold text-ui-ink';
const ROW_BODY = 'text-ui-md text-ui-muted';

export function SecuritySection({
  api,
  prefs,
  capabilities,
  identityName,
  onLockNow,
  onIdentityWiped,
  onAutolockChanged,
  platform = 'windows',
  onOpenReinforced,
  autoFocus,
}: SecuritySectionProps) {
  const t = useT();
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [autolock, setAutolock] = useState(() => prefs.getAutolockMinutes());
  const [passphraseChanged, setPassphraseChanged] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  // Back from the emergency key's page, the focus goes to this section's heading.
  const [moved, setMoved] = useState(false);
  const autolockId = useId();

  const readStatus = useCallback(async () => {
    try {
      const status = await api.status();
      setTotpEnabled(status.totp_enabled);
      setStatusFailed(status.totp_enabled === null);
    } catch {
      setStatusFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  const autolockLabel = (minutes: number) =>
    minutes === 0
      ? t('settings2.security.autolockNever')
      : minutes === 1
        ? t('settings2.security.autolockMinute')
        : minutes === 60
          ? t('settings2.security.autolockHour')
          : t('settings2.security.autolockMinutes', { n: minutes });
  const autolockChoices: readonly number[] = (AUTOLOCK_CHOICES as readonly number[]).includes(autolock)
    ? AUTOLOCK_CHOICES
    : [...AUTOLOCK_CHOICES, autolock].sort((a, b) => a - b);

  const totpText =
    totpEnabled === null
      ? statusFailed
        ? t('settings2.security.totpUnknown')
        : ''
      : t(totpEnabled ? 'settings2.security.totpOn' : 'settings2.security.totpOff');

  if (emergencyOpen) {
    return (
      <EmergencyKeyView
        autoFocus
        api={api}
        totpEnabled={totpEnabled === true}
        platform={platform}
        isVerified={prefs.isVerified}
        onBack={() => {
          setMoved(true);
          setEmergencyOpen(false);
        }}
        {...(onOpenReinforced && { onOpenReinforced })}
      />
    );
  }

  return (
    <SettingsSection title={t('settings2.security.title')} autoFocus={autoFocus || moved}>
      <div className="flex flex-col">
        <div className={ROW}>
          <span className={ROW_TEXT}>
            <span className={ROW_TITLE}>{t('settings2.security.passphrase')}</span>
            <span className={ROW_BODY}>{t('settings2.security.passphraseBody')}</span>
          </span>
          {capabilities.changePassphrase ? (
            <Button
              onClick={() => {
                setPassphraseChanged(false);
                setDialog('passphrase');
              }}
            >
              {t('settings2.security.changePassphrase')}
            </Button>
          ) : null}
        </div>

        <div className={ROW}>
          <span className={ROW_TEXT}>
            <span className={ROW_TITLE}>{t('settings2.security.totp')}</span>
            <span className={ROW_BODY} aria-live="polite">
              {totpText}
            </span>
          </span>
          {capabilities.totp && totpEnabled !== null ? (
            <Button onClick={() => setDialog('totp')}>
              {t(totpEnabled ? 'settings2.security.disable' : 'settings2.security.enable')}
            </Button>
          ) : null}
        </div>

        <div className={ROW}>
          <span className={ROW_TEXT}>
            <label htmlFor={autolockId} className={ROW_TITLE}>
              {t('settings2.security.autolock')}
            </label>
            <span id={`${autolockId}-body`} className={ROW_BODY}>
              {t('settings2.security.autolockBody')}
            </span>
          </span>
          <Select
            id={autolockId}
            aria-describedby={`${autolockId}-body`}
            value={String(autolock)}
            onChange={event => {
              const minutes = Number(event.target.value);
              setAutolock(minutes);
              prefs.setAutolockMinutes(minutes);
              onAutolockChanged(minutes);
            }}
          >
            {autolockChoices.map(minutes => (
              <option key={minutes} value={String(minutes)}>
                {autolockLabel(minutes)}
              </option>
            ))}
          </Select>
        </div>

        <div className={ROW}>
          <span className={ROW_TEXT}>
            <span className={ROW_TITLE}>{t('settings2.security.lockNow')}</span>
            <span className={ROW_BODY}>{t('settings2.security.lockNowBody')}</span>
          </span>
          <Button leadingIcon={<Lock {...iconSize('md')} />} onClick={onLockNow}>
            {t('settings2.security.lock')}
          </Button>
        </div>
      </div>

      {capabilities.emergencyKey ? (
        <SettingsRows
          label={t('emergency.row.title')}
          items={[
            {
              id: 'emergency',
              icon: KeyRound,
              label: t('emergency.row.title'),
              body: t('emergency.row.body'),
              onSelect: () => setEmergencyOpen(true),
            },
          ]}
        />
      ) : null}

      <p role="status" className="m-0 text-ui-md text-ui-muted">
        {passphraseChanged ? t('settings2.security.passphraseChanged') : ''}
      </p>

      <div className="flex flex-col gap-2.5 rounded-ui border border-ui-danger p-4 font-ui">
        <h3 className="m-0 text-ui-base font-bold text-ui-danger">{t('settings2.security.wipeTitle')}</h3>
        <p className="m-0 text-ui-md leading-normal text-ui-ink">{t('settings2.security.wipeBody')}</p>
        <Button variant="danger" className="self-start" onClick={() => setDialog('wipe')}>
          {t('settings2.security.wipe')}
        </Button>
      </div>

      {dialog === 'totp' && totpEnabled !== null ? (
        <TotpDialog
          mode={totpEnabled ? 'disable' : 'enable'}
          api={api}
          label={identityName}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void readStatus();
          }}
        />
      ) : null}
      {dialog === 'passphrase' ? (
        <ChangePassphraseDialog
          api={api}
          totpEnabled={totpEnabled === true}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setPassphraseChanged(true);
          }}
        />
      ) : null}
      {dialog === 'wipe' ? <WipeDialog api={api} onClose={() => setDialog(null)} onWiped={onIdentityWiped} /> : null}
    </SettingsSection>
  );
}
