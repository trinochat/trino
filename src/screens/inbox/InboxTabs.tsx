/**
 * "Chats | Llamadas · N" (PropLlamadas:47-51), the tabs of the library under
 * the connection chip. N is the missed calls not seen yet; it reads in full
 * to a screen reader ("Llamadas, 2 perdidas sin ver") and is left out at 0.
 */
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n';
import { Tabs } from '../../ui';

export type InboxTab = 'chats' | 'calls';

export interface InboxTabsProps {
  tab: InboxTab;
  onTabChange(tab: InboxTab): void;
  missedUnseen: number;
  chats: ReactNode;
  calls: ReactNode;
}

export function InboxTabs({ tab, onTabChange, missedUnseen, chats, calls }: InboxTabsProps) {
  const t = useT();
  const callsLabel =
    missedUnseen > 0 ? (
      <>
        <span aria-hidden="true">{t('inbox.tabs.callsMissed', { n: missedUnseen })}</span>
        <span className="sr-only">
          {missedUnseen === 1 ? t('inbox.tabs.callsMissedA11yOne') : t('inbox.tabs.callsMissedA11y', { n: missedUnseen })}
        </span>
      </>
    ) : (
      t('inbox.tabs.calls')
    );
  return (
    <Tabs
      aria-label={t('inbox.tabs.label')}
      value={tab}
      onValueChange={onTabChange}
      items={[
        { value: 'chats', label: t('inbox.tabs.chats'), panel: chats },
        { value: 'calls', label: callsLabel, panel: calls },
      ]}
      className="min-h-0 flex-1"
      // A hidden panel keeps the `hidden` attribute's display: none.
      panelClassName="min-h-0 flex-1 flex-col gap-3 [&:not([hidden])]:flex"
    />
  );
}
