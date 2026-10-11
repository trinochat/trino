// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { classesOf } from '../test-harness';
import { StepProgress } from './StepProgress';

afterEach(cleanup);

describe('StepProgress', () => {
  // Onboarding:48-53: one bar per step, filled up to the current one. The
  // header says "Paso n de 5" in words, so the bars are only decoration.
  it('fills as many of its bars as the current step, hidden from assistive technology', () => {
    const { container } = render(<StepProgress current={2} total={5} />);
    const bars = container.firstElementChild!;
    expect(bars.getAttribute('aria-hidden')).toBe('true');
    expect(bars.children.length).toBe(5);
    const filled = Array.from(bars.children).filter(bar => bar.hasAttribute('data-filled'));
    expect(filled.length).toBe(2);
    expect(classesOf(filled[1])).toContain('bg-ui-accent');
    expect(classesOf(bars.children[2])).toContain('bg-ui-line');
  });

  it('fills every bar on the last step', () => {
    const { container } = render(<StepProgress current={5} total={5} />);
    expect(container.querySelectorAll('[data-filled]').length).toBe(5);
  });
});
