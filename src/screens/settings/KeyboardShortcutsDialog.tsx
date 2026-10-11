/**
 * "Atajos de teclado" (accesibilidad.md §6): every shortcut of the app in
 * one list, opened from Settings > Accesibilidad. Each one takes Ctrl or
 * works only where its control has the focus (WCAG 2.1.4). Escape closes it.
 */
import { useT } from '../../lib/i18n';
import { Dialog } from '../../ui';

interface Shortcut {
  /** The keys as they read on a keyboard; `null` takes them from the texts. */
  keys: readonly string[] | null;
  label: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['Ctrl + K'], label: 'settings2.shortcuts.search' },
  { keys: ['Ctrl + L'], label: 'settings2.shortcuts.lock' },
  { keys: ['Ctrl + +', 'Ctrl + −'], label: 'settings2.shortcuts.textSize' },
  { keys: ['Ctrl + 0'], label: 'settings2.shortcuts.textSizeSystem' },
  { keys: ['Enter'], label: 'settings2.shortcuts.send' },
  // Shift has a name of its own in Spanish keyboards: Mayús.
  { keys: null, label: 'settings2.shortcuts.newLine' },
  { keys: ['Esc'], label: 'settings2.shortcuts.close' },
];

export function KeyboardShortcutsDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  return (
    <Dialog open onClose={onClose} closeLabel={t('common2.close')} title={t('settings2.shortcuts.title')}>
      <dl className="m-0 flex flex-col font-ui">
        {SHORTCUTS.map(({ keys, label }) => (
          <div key={label} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ui-line py-2.5 last:border-b-0">
            <dt className="flex min-w-[8.5rem] flex-wrap gap-1.5">
              {(keys ?? [t('settings2.shortcuts.newLineKeys')]).map(key => (
                <kbd
                  key={key}
                  className="rounded-ui border border-ui-control-line bg-ui-raised px-1.5 py-0.5 font-ui-mono text-ui-sm text-ui-ink"
                >
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="m-0 min-w-0 flex-1 text-ui-base text-ui-ink">{t(label)}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
