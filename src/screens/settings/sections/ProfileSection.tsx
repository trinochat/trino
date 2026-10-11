/**
 * Settings > Perfil (PropAjustes:123-166): your photo, your name and, when
 * your profile reaches your contacts, "Sobre mí", with one honest line on
 * who gets them (plan-cambios-11oct §6):
 *
 * - the shared profile (`profileSync` and a backend that sends it,
 *   `sync === 1`): the line of the board, PropAjustes:139, plus how many of
 *   your contacts do not get it yet, when any;
 * - otherwise: the photo and the name stay on this device (plan §1.5), and
 *   there is no "Sobre mí".
 *
 * The photo goes through `makeAvatar`, so it fits what the backend takes, and
 * nothing is saved until "Guardar". "Cómo te encuentran" lists the ways
 * people find you; this batch has only your QR code.
 */
import { Camera, QrCode } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { isCommandError, type ProfileResponse } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { identityInitials } from '../../../lib/initials';
import { Avatar, Button, cx, Field, FOCUS_RING, iconSize, Input, Textarea } from '../../../ui';
import { ErrorLine } from '../ErrorLine';
import { capScalars, countScalars } from '../scalars';
import { SettingsRows, type SettingsRowItem } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi } from '../types';

/** Your name, as the first run takes it (W1). */
export const NAME_MAX = 40;
/** "Sobre mí", as the backend takes it (K12). */
export const ABOUT_MAX = 140;

export interface ProfileSectionProps {
  api: Pick<SettingsApi, 'updateProfile' | 'listNodes'>;
  profile: ProfileResponse;
  /** The backend sends your profile to your contacts (K12). */
  profileSync: boolean;
  makeAvatar(file: File): Promise<string>;
  onOpenQr(): void;
  /** The profile was saved: read it again. */
  onSaved(): void;
  autoFocus?: boolean;
}

type ProfileError = 'invalid' | 'save' | 'photo';

const ERROR_KEYS: Record<ProfileError, string> = {
  invalid: 'settings2.profile.errInvalid',
  save: 'settings2.profile.errSave',
  photo: 'settings2.profile.errPhoto',
};

export function ProfileSection({ api, profile, profileSync, makeAvatar, onOpenQr, onSaved, autoFocus }: ProfileSectionProps) {
  const t = useT();
  const synced = profileSync && profile.sync === 1;
  const [name, setName] = useState(profile.handle);
  const [avatar, setAvatar] = useState<string | null>(profile.avatar);
  const [about, setAbout] = useState(profile.about ?? '');
  const [nameMissing, setNameMissing] = useState(false);
  const [error, setError] = useState<ProfileError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notReached, setNotReached] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const counterId = useId();

  // Who does not get your profile yet: the contacts, not blocked, whose
  // Trino has not said it takes profiles. Unknown if the list fails.
  useEffect(() => {
    if (!synced) return;
    let live = true;
    api.listNodes().then(
      nodes => {
        if (live) setNotReached(nodes.filter(n => !n.blocked && !n.profile_sync).length);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, synced]);

  const edited = () => {
    setSaved(false);
    setError(null);
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    edited();
    try {
      setAvatar(await makeAvatar(file));
    } catch {
      setError('photo');
    }
  };

  const save = async () => {
    const handle = name.trim();
    if (!handle) {
      setNameMissing(true);
      nameInput.current?.focus();
      return;
    }
    edited();
    setBusy(true);
    try {
      await api.updateProfile(handle, avatar, synced ? about.trim() : undefined);
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(isCommandError(cause) && cause.code === 'profile_invalid' ? 'invalid' : 'save');
    } finally {
      setBusy(false);
    }
  };

  const findYou = useMemo<SettingsRowItem[]>(
    () => [
      {
        id: 'qr',
        icon: QrCode,
        label: t('settings2.profile.qrRow'),
        body: t('settings2.profile.qrRowBody'),
        onSelect: onOpenQr,
      },
    ],
    [t, onOpenQr],
  );

  return (
    <SettingsSection title={t('settings2.profile.title')} autoFocus={autoFocus}>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar
          size={80}
          src={avatar ?? undefined}
          initials={identityInitials(name || profile.handle)}
          alt={avatar ? t('settings2.profile.photoAlt') : undefined}
        />
        <div className="flex flex-wrap gap-2">
          <Button leadingIcon={<Camera {...iconSize('md')} />} onClick={() => fileInput.current?.click()}>
            {t('settings2.profile.editPhoto')}
          </Button>
          {avatar ? (
            <button
              type="button"
              onClick={() => {
                edited();
                setAvatar(null);
              }}
              className={cx(
                'inline-flex min-h-11 items-center rounded-ui px-4 font-ui text-ui-base font-semibold text-ui-danger hover:bg-ui-danger-bg',
                FOCUS_RING,
              )}
            >
              {t('settings2.profile.removePhoto')}
            </button>
          ) : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          tabIndex={-1}
          onChange={event => {
            void pickPhoto(event.target.files?.[0]);
            // The same file again is a new choice.
            event.target.value = '';
          }}
        />
      </div>

      <Field label={t('settings2.profile.name')} error={nameMissing ? t('settings2.profile.errName') : undefined}>
        <Input
          ref={nameInput}
          value={name}
          autoComplete="off"
          onChange={event => {
            edited();
            setNameMissing(false);
            setName(capScalars(event.target.value, NAME_MAX));
          }}
        />
      </Field>

      {synced ? (
        <Field label={t('settings2.profile.about')}>
          <Textarea
            minRows={3}
            maxRows={3}
            value={about}
            aria-describedby={counterId}
            onChange={event => {
              edited();
              setAbout(capScalars(event.target.value, ABOUT_MAX));
            }}
          />
          <span id={counterId} className="self-end font-ui-mono text-ui-xs text-ui-muted">
            {t('settings2.profile.aboutCount', { n: countScalars(about) })}
          </span>
        </Field>
      ) : null}

      <div className="flex flex-col gap-2 text-ui-md leading-normal text-ui-muted">
        <p className="m-0">{t(synced ? 'settings2.profile.shared' : 'settings2.profile.local')}</p>
        {synced && notReached > 0 ? (
          <p className="m-0">
            {notReached === 1
              ? t('settings2.profile.sharedPendingOne')
              : t('settings2.profile.sharedPending', { n: notReached })}
          </p>
        ) : null}
      </div>

      <SettingsRows label={t('settings2.profile.findYou')} items={findYou} />

      {error ? <ErrorLine>{t(ERROR_KEYS[error])}</ErrorLine> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {t('common2.save')}
        </Button>
        <p role="status" className="m-0 text-ui-md text-ui-muted">
          {saved ? t('settings2.profile.saved') : ''}
        </p>
      </div>
    </SettingsSection>
  );
}
