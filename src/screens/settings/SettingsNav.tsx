/**
 * The navigation of Settings (PropAjustes:41-119): the heading, a button
 * that closes Settings, your profile card, and the sections in three named
 * groups, each row an outline icon, its name and a chevron, 48 px or more.
 *
 * - Cuenta: "Cuenta y seguridad".
 * - Uso: Privacidad, Notificaciones, Apariencia, Accesibilidad, Idioma.
 * - Más: Avanzado.
 *
 * The section on screen has aria-current="page", bold text, the `raised`
 * fill and its icon in the accent; under forced colours, where the fill
 * and the colour are lost, a highlighted bar at its start stays. "Apoyar a
 * Trino" is not built: it waits for the decisions on donations.
 */
import {
  Accessibility,
  Bell,
  ChevronRight,
  Contrast,
  Languages,
  Lock,
  Shield,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useT } from '../../lib/i18n';
import { cx, FOCUS_RING_INSET, iconSize, IconButton } from '../../ui';
import { ProfileCard } from './ProfileCard';
import type { SettingsSectionId } from './types';

export interface SettingsNavProps {
  /** The section on screen; null when none is, as in the list on one pane. */
  current: SettingsSectionId | null;
  /** "Tu código QR" is on screen. */
  qrOpen: boolean;
  /** Your name and photo for the card; null while they load. */
  profile: { name: string; avatar?: string | null } | null;
  findableName?: string;
  onSelect(id: SettingsSectionId): void;
  onOpenQr(): void;
  onClose(): void;
  /** Gives this section's row the focus when the list opens, as after "Volver a ajustes". */
  focusId?: SettingsSectionId;
  className?: string;
}

type ListedSection = Exclude<SettingsSectionId, 'profile'>;

const GROUPS: ReadonlyArray<{ label: string; sections: readonly ListedSection[] }> = [
  { label: 'settings2.nav.groupAccount', sections: ['security'] },
  { label: 'settings2.nav.groupUse', sections: ['privacy', 'notifications', 'appearance', 'accessibility', 'language'] },
  { label: 'settings2.nav.groupMore', sections: ['advanced'] },
];

const ICONS: Record<ListedSection, LucideIcon> = {
  security: Lock,
  privacy: Shield,
  notifications: Bell,
  appearance: Contrast,
  accessibility: Accessibility,
  language: Languages,
  advanced: SlidersHorizontal,
};

/** The name of a section, in the navigation and as the heading of the section. */
export const SECTION_TITLE_KEYS: Record<SettingsSectionId, string> = {
  profile: 'settings2.profile.title',
  security: 'settings2.nav.security',
  privacy: 'settings2.nav.privacy',
  notifications: 'settings2.nav.notifications',
  appearance: 'settings2.nav.appearance',
  accessibility: 'settings2.nav.accessibility',
  language: 'settings2.nav.language',
  advanced: 'settings2.nav.advanced',
};

export function SettingsNav({
  current,
  qrOpen,
  profile,
  findableName,
  onSelect,
  onOpenQr,
  onClose,
  focusId,
  className,
}: SettingsNavProps) {
  const t = useT();
  const rows = useRef(new Map<SettingsSectionId, HTMLButtonElement>());

  useEffect(() => {
    if (focusId) rows.current.get(focusId)?.focus();
    // Once, when the list opens.
  }, []);

  return (
    <nav aria-label={t('settings2.nav.label')} className={cx('flex min-w-0 flex-col gap-3.5', className)}>
      <div className="flex items-center justify-between gap-2 pl-1.5">
        <h1 className="m-0 font-ui-display text-ui-title font-bold text-ui-ink">{t('settings2.nav.title')}</h1>
        <IconButton aria-label={t('settings2.nav.close')} icon={<X {...iconSize('lg')} />} onClick={onClose} />
      </div>

      <ProfileCard
        name={profile?.name ?? t('settings2.profile.title')}
        avatar={profile?.avatar}
        findableName={findableName}
        current={current === 'profile' && !qrOpen}
        qrCurrent={current === 'profile' && qrOpen}
        onOpenProfile={() => onSelect('profile')}
        onOpenQr={onOpenQr}
      />

      {GROUPS.map(group => (
        <ul
          key={group.label}
          role="list"
          aria-label={t(group.label)}
          className="m-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line bg-ui-surface p-0"
        >
          {group.sections.map((id, index) => {
            const Icon = ICONS[id];
            const on = current === id;
            return (
              <li key={id} className={cx(index > 0 && 'border-t border-ui-line')}>
                <button
                  ref={element => {
                    if (element) rows.current.set(id, element);
                    else rows.current.delete(id);
                  }}
                  type="button"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => onSelect(id)}
                  className={cx(
                    'flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left font-ui text-ui-base text-ui-ink',
                    'transition-colors reduce-motion:transition-none',
                    on
                      ? 'bg-ui-raised font-bold forced-colors:border-s-4 forced-colors:border-[color:Highlight]'
                      : 'font-medium hover:bg-ui-raised',
                    FOCUS_RING_INSET,
                  )}
                >
                  <span className={cx('flex shrink-0', on ? 'text-ui-accent-text' : 'text-ui-muted')}>
                    <Icon {...iconSize('lg')} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">{t(SECTION_TITLE_KEYS[id])}</span>
                  <ChevronRight {...iconSize('md', 'shrink-0 text-ui-muted')} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}
