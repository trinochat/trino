/**
 * Settings > Privacidad (plan-cambios-11oct §4 W5): "Contactos bloqueados"
 * with how many there are, which opens their list, and one fixed line on
 * how calls protect your IP (TURN through Cloudflare, docs/llamadas-turn.md).
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
import { BlockedContactsView } from '../BlockedContactsView';
import { ErrorLine } from '../ErrorLine';
import { SettingsRows, type SettingsRowItem } from '../SettingsRows';
import { SettingsSection } from '../SettingsSection';
import type { SettingsApi } from '../types';

export interface PrivacySectionProps {
  api: Pick<SettingsApi, 'listNodes' | 'blockNode'>;
  /** A contact was unblocked: the shell reads its contacts again. */
  onContactsChanged?(): void;
  autoFocus?: boolean;
}

type View = 'main' | 'blocked';

export function PrivacySection({ api, onContactsChanged, autoFocus }: PrivacySectionProps) {
  const t = useT();
  const [nodes, setNodes] = useState<readonly NodeInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<View>('main');
  // After the first view, a change of view moves the focus to the new heading.
  const [moved, setMoved] = useState(false);

  const load = useCallback(async () => {
    try {
      setNodes(await api.listNodes());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
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
        blocked={blocked}
        onBack={() => setView('main')}
        onUnblock={async handle => {
          await api.blockNode(handle, false);
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
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.privacy.callsLine')}</p>
    </SettingsSection>
  );
}
