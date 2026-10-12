/**
 * Settings > Privacidad (plan-cambios-11oct §4 W5): "Contactos bloqueados"
 * with how many there are, which opens their list, and one fixed line on
 * how calls protect your IP (TURN through Cloudflare, docs/llamadas-turn.md).
 *
 * And "Bloquear capturas de pantalla" (SC-1; David, 12 Oct: on by default,
 * and anyone can turn it off): each change goes to the window at once
 * through `setContentProtected`, and is kept in this device's preferences,
 * where main.tsx reads it before unlocking (src/app/capture-protection.ts).
 * Its words say what it does not do: a photo of the screen with another
 * phone. On macOS some recorders ignore it, and the text says so; Linux has
 * nothing for it, so the switch is not there.
 *
 * Not here, on purpose: the IP warning before a call (TURN made it
 * unnecessary), Tor and "Quién puede escribirte" (no Tor, no message
 * requests in this batch), the @name (§8) and the default timer of
 * disappearing messages (later). Nor a promise that everything on this
 * device is encrypted: config.json, friends.json and the like are not yet
 * (the parent's addendum). The rows come from an array, so the invitations
 * unit adds "Que me encuentren por @nombre" and its links there (§8).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NodeInfo } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import type { Prefs } from '../../../lib/prefs';
import { Switch } from '../../../ui';
import { BlockedContactsView } from '../BlockedContactsView';
import { ErrorLine } from '../ErrorLine';
import { SettingsRows, type SettingsRowItem } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi, SettingsPlatform } from '../types';

export interface PrivacySectionProps {
  api: Pick<SettingsApi, 'listNodes' | 'blockNode' | 'setContentProtected'>;
  /** Where the block of screen captures is kept. */
  prefs: Pick<Prefs, 'getBlockCaptures' | 'setBlockCaptures'>;
  /** Linux cannot keep a window out of captures: no switch there. */
  platform: SettingsPlatform;
  /** A contact was unblocked: the shell reads its contacts again. */
  onContactsChanged?(): void;
  autoFocus?: boolean;
}

type View = 'main' | 'blocked';

/** Why the switch of captures failed: the window refused, or the choice could not be kept. */
type CapturesError = 'window' | 'save';

const CAPTURES_ERROR_KEYS: Record<CapturesError, string> = {
  window: 'settings2.privacy.errCaptures',
  save: 'settings2.privacy.errCapturesSave',
};

export function PrivacySection({ api, prefs, platform, onContactsChanged, autoFocus }: PrivacySectionProps) {
  const t = useT();
  const [nodes, setNodes] = useState<readonly NodeInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<View>('main');
  // After the first view, a change of view moves the focus to the new heading.
  const [moved, setMoved] = useState(false);
  const [blockCaptures, setBlockCaptures] = useState(() => prefs.getBlockCaptures());
  const [capturesError, setCapturesError] = useState<CapturesError | null>(null);

  /** The window first: only a change it took is kept. */
  const toggleCaptures = async (on: boolean) => {
    setBlockCaptures(on);
    setCapturesError(null);
    try {
      await api.setContentProtected(on);
    } catch {
      setBlockCaptures(!on);
      setCapturesError('window');
      return;
    }
    if (!prefs.setBlockCaptures(on)) setCapturesError('save');
  };

  /** Reads the contacts; resolves to whether they could be read. */
  const load = useCallback(async () => {
    try {
      setNodes(await api.listNodes());
      setLoadFailed(false);
      return true;
    } catch {
      setLoadFailed(true);
      return false;
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const blocked = useMemo(() => (nodes ?? []).filter(contact => contact.blocked), [nodes]);

  const rows = useMemo<SettingsRowItem[]>(
    () => [
      {
        id: 'blocked',
        label: t('settings2.privacy.blocked'),
        value: nodes === null ? undefined : blocked.length === 0 ? t('settings2.privacy.blockedNone') : String(blocked.length),
        onSelect: () => {
          setMoved(true);
          setView('blocked');
        },
      },
    ],
    [t, nodes, blocked],
  );

  if (view === 'blocked') {
    return (
      <BlockedContactsView
        autoFocus
        blocked={nodes === null ? null : blocked}
        loadFailed={loadFailed}
        onRetry={load}
        onBack={() => setView('main')}
        onUnblock={async handle => {
          await api.blockNode(handle, false);
          // Unblocked, even if the list cannot be read again just now.
          setNodes(current =>
            current ? current.map(contact => (contact.handle === handle ? { ...contact, blocked: false } : contact)) : current,
          );
          onContactsChanged?.();
          await load();
        }}
      />
    );
  }

  return (
    <SettingsSection title={t('settings2.privacy.title')} autoFocus={autoFocus || moved}>
      {loadFailed ? <ErrorLine>{t('settings2.privacy.errLoad')}</ErrorLine> : null}
      <SettingsRows label={t('settings2.privacy.title')} items={rows} />
      {platform === 'linux' ? null : (
        <div className="flex flex-col gap-2">
          <Switch
            className="border-y border-ui-line py-3.5"
            label={t('settings2.privacy.captures')}
            description={t(platform === 'macos' ? 'settings2.privacy.capturesBodyMac' : 'settings2.privacy.capturesBody')}
            checked={blockCaptures}
            onCheckedChange={on => void toggleCaptures(on)}
          />
          {capturesError ? <ErrorLine>{t(CAPTURES_ERROR_KEYS[capturesError])}</ErrorLine> : null}
        </div>
      )}
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.privacy.callsLine')}</p>
    </SettingsSection>
  );
}
