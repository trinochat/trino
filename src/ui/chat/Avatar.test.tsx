// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from './Avatar';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('Avatar', () => {
  it('shows a person’s initials in the accent colours, with the avatar radius, as decoration', () => {
    const { container } = render(<Avatar initials="AT" />);
    const avatar = container.firstElementChild;
    expect(avatar?.textContent).toBe('AT');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    const classes = classesOf(avatar);
    for (const token of ['bg-ui-accent-soft', 'text-ui-accent-text', 'rounded-ui-avatar']) {
      expect(classes).toContain(token);
    }
    expect(classes).not.toContain('bg-ui-avatar-bg');
  });

  it('squares a group: the base radius at list sizes, the large one from 64 px', () => {
    const { container, rerender } = render(<Avatar kind="group" initials="F" size={44} />);
    let classes = classesOf(container.firstElementChild);
    expect(classes).toContain('rounded-ui');
    expect(classes).toContain('bg-ui-accent-soft');
    expect(classes).not.toContain('rounded-ui-avatar');
    rerender(<Avatar kind="group" initials="F" size={80} />);
    classes = classesOf(container.firstElementChild);
    expect(classes).toContain('rounded-ui-lg');
    expect(classes).not.toContain('rounded-ui');
  });

  it('shows a message request as "?" in the warning colours', () => {
    const { container } = render(<Avatar kind="request" initials="AT" />);
    const avatar = container.firstElementChild;
    expect(avatar?.textContent).toBe('?');
    const classes = classesOf(avatar);
    expect(classes).toContain('bg-ui-warn-bg');
    expect(classes).toContain('text-ui-warn');
    expect(classes).toContain('rounded-ui-avatar');
  });

  it.each([
    [36, 'h-9', 'w-9'],
    [40, 'h-10', 'w-10'],
    [44, 'h-11', 'w-11'],
    [48, 'h-12', 'w-12'],
    [64, 'h-16', 'w-16'],
    [80, 'h-20', 'w-20'],
    [96, 'h-24', 'w-24'],
  ] as const)('is %i px wide and tall', (size, height, width) => {
    const { container } = render(<Avatar initials="R" size={size} />);
    const classes = classesOf(container.firstElementChild);
    expect(classes).toContain(height);
    expect(classes).toContain(width);
  });

  it('is 44 px by default', () => {
    const { container } = render(<Avatar initials="R" />);
    expect(classesOf(container.firstElementChild)).toContain('h-11');
  });

  it('becomes an image with a name when given alt', () => {
    render(<Avatar initials="AT" alt="Ana Torres" />);
    const avatar = screen.getByRole('img', { name: 'Ana Torres' });
    expect(avatar.getAttribute('aria-hidden')).toBeNull();
  });

  it('shows the picture when given src, and the initials if it fails to load', () => {
    const { container } = render(<Avatar initials="AT" src="blob:foto" />);
    const picture = container.querySelector('img');
    expect(picture?.getAttribute('src')).toBe('blob:foto');
    expect(picture?.getAttribute('alt')).toBe('');
    fireEvent.error(picture!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild?.textContent).toBe('AT');
  });
});
