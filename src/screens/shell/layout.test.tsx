// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceProvider } from '../../design/useAppearance';
import { useShellLayout } from './layout';
import { appearanceHost } from './test-fakes';

afterEach(cleanup);

function Probe({ width, rootPx }: { width: number; rootPx?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} data-testid="shell" data-layout={useShellLayout(ref, width, rootPx)} />;
}

function layoutAt(width: number, { textScale = 1, rootPx }: { textScale?: number; rootPx?: number } = {}) {
  const { getByTestId, unmount } = render(
    <AppearanceProvider host={appearanceHost(textScale)}>
      <Probe width={width} rootPx={rootPx} />
    </AppearanceProvider>,
  );
  const layout = getByTestId('shell').getAttribute('data-layout');
  unmount();
  return layout;
}

describe('useShellLayout', () => {
  it('shows one pane below 47.5 rem, two from there, and the details beside them from 70 rem', () => {
    expect(layoutAt(759)).toBe('single');
    expect(layoutAt(760)).toBe('double');
    expect(layoutAt(1119)).toBe('double');
    expect(layoutAt(1120)).toBe('double-aside');
  });

  // The window does not change size when the text does, so the root size has
  // to come from the accessibility settings, not from a resize.
  it('measures in rem of the text size in effect: at 125 % two panes need 950 px', () => {
    expect(layoutAt(949, { textScale: 1.25 })).toBe('single');
    expect(layoutAt(950, { textScale: 1.25 })).toBe('double');
    expect(layoutAt(1399, { textScale: 1.25 })).toBe('double');
    expect(layoutAt(1400, { textScale: 1.25 })).toBe('double-aside');
  });

  it('takes a root size given by a test', () => {
    expect(layoutAt(949, { rootPx: 20 })).toBe('single');
    expect(layoutAt(950, { rootPx: 20 })).toBe('double');
  });
});
