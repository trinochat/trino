/**
 * Settings (W5): a panel inside the shell, not a modal (plan §3 W5), with
 * the navigation of PropAjustes on the left and the section on the right.
 *
 * Two panes from 47.5 rem, measured with the text size in effect
 * (`layoutFor`, accesibilidad.md §4.7): larger text turns them into one
 * before anything is cut. On one pane the navigation is a list of its own,
 * and a section opens over it with "Volver a ajustes" (rule 10). Each pane
 * scrolls by itself. A section shown in two panes is open: when the window
 * narrows or the text grows, it stays on its own pane, with what is being
 * typed, until "Volver a ajustes" or Escape.
 *
 * The profile is read here, for the card and for its section, and read
 * again after it is saved. When a view opens from something that went away
 * (a row on one pane, "Tu código QR" in the profile, "Volver al perfil"),
 * the focus moves to its heading; going back on one pane gives it to the
 * row of the section left, which for the profile and your QR code is the
 * button of your card. When a change made here (the layout, the profile
 * read again) takes away the control that had the focus, the heading of
 * the view on screen takes it. Escape goes back on one pane and otherwise
 * closes Settings, but not from inside a text field, where it would throw
 * away what is being typed.
 */
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ROOT_PX } from '../../design/apply';
import { layoutFor } from '../../design/layout';
import { useAccessibility } from '../../design/useAppearance';
import { makeAvatar as defaultMakeAvatar } from '../../lib/avatar';
import type { ProfileResponse } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { prefs as devicePrefs } from '../../lib/prefs';
import { Button, cx, iconSize, IconButton } from '../../ui';
import { ErrorLine } from './ErrorLine';
import { ProfileQrView } from './ProfileQrView';
import { AccessibilitySection } from './sections/AccessibilitySection';
import { AdvancedSection } from './sections/AdvancedSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { LanguageSection } from './sections/LanguageSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { PrivacySection } from './sections/PrivacySection';
import { ProfileSection } from './sections/ProfileSection';
import { SecuritySection } from './sections/SecuritySection';
import { SettingsNav, type SettingsNavFocus } from './SettingsNav';
import { SettingsSection } from './SettingsSection';
import type { SettingsScreenProps, SettingsSectionId } from './types';

/** The width of an element in px, followed while it changes; null before it is known. */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measured = element.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
}

/** A field where Escape belongs to the typing, not to the screen. */
function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit'].includes(target.type))
  );
}

export function SettingsScreen({
  section,
  onSectionChange,
  onClose,
  onLockNow,
  onIdentityWiped,
  onProfileChanged,
  onAutolockChanged,
  renderShareCode,
  api,
  platform,
  capabilities,
  prefs = devicePrefs,
  makeAvatar = defaultMakeAvatar,
  width,
  onContactsChanged,
  net,
}: SettingsScreenProps) {
  const t = useT();
  const { effective } = useAccessibility();
  const root = useRef<HTMLDivElement>(null);
  const sectionPane = useRef<HTMLDivElement>(null);
  /** What had the focus in Settings last, to tell when a change made here took it away. */
  const lastFocus = useRef<Element | null>(null);
  const measured = useMeasuredWidth(root, width === undefined);
  const single = layoutFor(width ?? measured ?? window.innerWidth, ROOT_PX * effective.textScale) === 'single';
  // Before the first measure the window's width is only a guess: Settings
  // sits beside the shell's sidebar, and may get one pane where the window
  // would have two.
  const twoPanes = !single && (width !== undefined || measured !== null);

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  /** One pane: the list, or the section over it. A section shown in two panes is open too. */
  const [showSection, setShowSection] = useState(twoPanes);
  if (twoPanes && !showSection) setShowSection(true);
  /** The view opened from something that went away: its heading takes the focus. */
  const [focusView, setFocusView] = useState(false);
  /** One pane, back from a section: its row, or your card's QR button, takes the focus. */
  const [focusRow, setFocusRow] = useState<SettingsNavFocus | undefined>(undefined);

  const readProfile = useCallback(async () => {
    setProfileFailed(false);
    try {
      setProfile(await api.getProfile());
    } catch {
      setProfileFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void readProfile();
  }, [readProfile]);

  // The view that asked for the focus took it as it mounted (a child's
  // effect runs first); a later change, such as the shell opening another
  // section, leaves the focus where it is.
  useEffect(() => {
    if (focusView) setFocusView(false);
  }, [section, qrOpen, showSection]);

  // A change made here can take away the control that had the focus: the
  // rows when two panes turn into one, "Volver a ajustes" when one pane
  // turns into two, "Reintentar" and then the whole view while the profile
  // is read. The heading of the view on screen takes the focus then, rather
  // than the page. After every render: whatever changed, a lost focus is
  // caught before it is painted.
  useLayoutEffect(() => {
    const lost = lastFocus.current;
    if (!lost || lost.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    sectionPane.current?.querySelector<HTMLElement>('h2')?.focus();
  });

  const open = (id: SettingsSectionId, { qr = false, focus = single } = {}) => {
    setQrOpen(qr);
    setFocusView(focus);
    setShowSection(true);
    if (id !== section) onSectionChange(id);
  };

  const backToList = () => {
    setFocusRow(section === 'profile' && qrOpen ? 'qr' : section);
    setShowSection(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // A dialog opened from here sits in a portal: its Escape is its own.
    if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return;
    if (isTextField(event.target)) return;
    event.preventDefault();
    if (single && showSection) backToList();
    else onClose();
  };

  const listOnly = single && !showSection;
  const sectionOnly = single && showSection;

  const sectionView = (): ReactNode => {
    const autoFocus = focusView;
    switch (section) {
      case 'profile':
        if (qrOpen) {
          return (
            <ProfileQrView
              autoFocus={autoFocus}
              renderShareCode={renderShareCode}
              onBack={() => {
                setFocusView(true);
                setQrOpen(false);
              }}
            />
          );
        }
        if (profile) {
          return (
            <ProfileSection
              autoFocus={autoFocus}
              api={api}
              profile={profile}
              profileSync={capabilities.profileSync}
              makeAvatar={makeAvatar}
              onOpenQr={() => open('profile', { qr: true, focus: true })}
              onSaved={() => {
                onProfileChanged();
                void readProfile();
              }}
            />
          );
        }
        return (
          <SettingsSection title={t('settings2.profile.title')} autoFocus={autoFocus}>
            {profileFailed ? (
              <>
                <ErrorLine>{t('settings2.profile.errLoad')}</ErrorLine>
                <Button className="self-start" onClick={() => void readProfile()}>
                  {t('common2.retry')}
                </Button>
              </>
            ) : (
              <p role="status" className="m-0 text-ui-base text-ui-muted">
                {t('settings2.profile.loading')}
              </p>
            )}
          </SettingsSection>
        );
      case 'privacy':
        return (
          <PrivacySection
            autoFocus={autoFocus}
            api={api}
            prefs={prefs}
            platform={platform}
            onContactsChanged={onContactsChanged}
            onAutolockChanged={onAutolockChanged}
            {...(net && { net })}
          />
        );
      case 'notifications':
        return <NotificationsSection autoFocus={autoFocus} api={api} prefs={prefs} platform={platform} />;
      case 'security':
        return (
          <SecuritySection
            autoFocus={autoFocus}
            api={api}
            prefs={prefs}
            capabilities={capabilities}
            identityName={profile?.handle ?? ''}
            onLockNow={onLockNow}
            onIdentityWiped={onIdentityWiped}
            onAutolockChanged={onAutolockChanged}
          />
        );
      case 'appearance':
        return <AppearanceSection autoFocus={autoFocus} />;
      case 'accessibility':
        return <AccessibilitySection autoFocus={autoFocus} platform={platform} />;
      case 'language':
        return <LanguageSection autoFocus={autoFocus} />;
      case 'advanced':
        return <AdvancedSection autoFocus={autoFocus} api={api} profile={profile} capabilities={capabilities} />;
    }
  };

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      onFocus={event => {
        lastFocus.current = event.target;
      }}
      className="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-ui-bg font-ui text-ui-ink [background-image:var(--t-scan)]"
    >
      {sectionOnly ? null : (
        <div
          className={cx(
            'min-h-0 overflow-y-auto border-ui-line bg-ui-side px-3.5 py-5',
            listOnly ? 'w-full' : 'w-[18.75rem] shrink-0 border-r',
          )}
        >
          <SettingsNav
            current={listOnly ? null : section}
            qrOpen={qrOpen}
            profile={profile ? { name: profile.handle, avatar: profile.avatar } : null}
            focusId={listOnly ? focusRow : undefined}
            onSelect={id => open(id)}
            onOpenQr={() => open('profile', { qr: true })}
            onClose={onClose}
          />
        </div>
      )}
      {listOnly ? null : (
        <div
          ref={sectionPane}
          className={cx(
            'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-ui-surface',
            single ? 'px-4 py-5' : 'px-8 py-7',
          )}
        >
          {sectionOnly ? (
            <IconButton
              className="-ml-2 self-start"
              aria-label={t('settings2.nav.back')}
              icon={<ArrowLeft {...iconSize('lg')} />}
              onClick={backToList}
            />
          ) : null}
          <div key={`${section}:${qrOpen ? 'qr' : 'view'}`} className="contents">
            {sectionView()}
          </div>
        </div>
      )}
    </div>
  );
}
