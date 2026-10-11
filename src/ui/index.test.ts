import { describe, expect, it } from 'vitest';
import * as controls from './controls';
import * as ui from './index';

/** The overlays, the chat pieces and the brand, each module a component with its types. */
const COMPONENT_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./overlay/*.tsx', './chat/*.tsx', './brand/*.tsx', '!./**/*.test.tsx'],
  { eager: true },
);

/** What the screens reach for first. */
const KEY_EXPORTS = [
  'Button',
  'Field',
  'Switch',
  'Dialog',
  'Menu',
  'ToastProvider',
  'useToast',
  'ChatRow',
  'MessageBubble',
  'ConnectionChip',
  'TrinoLogo',
  'FOCUS_RING',
  'iconSize',
  'cx',
];

/** The names a module exports that the barrel does not, as `module: name`. */
function notReexported(path: string, module: Record<string, unknown>): string[] {
  return Object.keys(module)
    .filter(name => !(name in ui))
    .map(name => `${path}: ${name}`);
}

describe('the library barrel, src/ui/index.ts', () => {
  it('exports the pieces the screens reach for', () => {
    expect(KEY_EXPORTS.filter(name => !(name in ui))).toEqual([]);
    expect(ui.cx('a', false, 'b')).toBe('a b');
    expect(ui.FOCUS_RING).toContain('focus-visible:outline-ui-accent-text');
    expect(ui.iconSize('md')).toEqual({ size: 16, className: 'size-[1rem]' });
  });

  it('re-exports everything controls/index.ts exports', () => {
    expect(notReexported('./controls/index.ts', controls)).toEqual([]);
  });

  it('re-exports every overlay, chat and brand component', () => {
    expect(Object.keys(COMPONENT_MODULES).length).toBeGreaterThanOrEqual(13);
    const missing = Object.entries(COMPONENT_MODULES).flatMap(([path, module]) => notReexported(path, module));
    expect(missing).toEqual([]);
  });
});
