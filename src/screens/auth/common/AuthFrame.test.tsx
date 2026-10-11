// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { classesOf } from '../test-harness';
import { AuthFrame } from './AuthFrame';

afterEach(cleanup);

describe('AuthFrame', () => {
  // A centred card that is taller than the window must scroll from its top:
  // in 800×600, or at 200 % text, nothing above the fold may be cut off.
  it('scrolls the whole screen and centres the card inside a box at least as tall', () => {
    render(<AuthFrame>contenido</AuthFrame>);
    const card = screen.getByRole('main');
    const inner = card.parentElement;
    const outer = inner?.parentElement ?? null;
    expect(classesOf(outer)).toEqual(expect.arrayContaining(['h-full', 'overflow-y-auto']));
    expect(classesOf(inner)).toEqual(expect.arrayContaining(['flex', 'min-h-full', 'items-center', 'justify-center']));
    expect(classesOf(inner)).not.toContain('h-full');
    expect(card.textContent).toBe('contenido');
  });

  // Onboarding:40 (560 px) and Unlock:50 (440 px), in rem so they follow the text.
  it('is as wide as the cards of the boards', () => {
    render(<AuthFrame>primer arranque</AuthFrame>);
    expect(classesOf(screen.getByRole('main'))).toContain('max-w-[35rem]');
    cleanup();
    render(<AuthFrame width="narrow">desbloqueo</AuthFrame>);
    expect(classesOf(screen.getByRole('main'))).toContain('max-w-[27.5rem]');
  });

  it("draws the theme's background, with Terminal's scan lines, behind a surface card", () => {
    render(<AuthFrame>contenido</AuthFrame>);
    const card = screen.getByRole('main');
    const outer = card.parentElement?.parentElement ?? null;
    expect(classesOf(outer)).toEqual(expect.arrayContaining(['bg-ui-bg', '[background-image:var(--t-scan)]']));
    expect(classesOf(card)).toEqual(expect.arrayContaining(['bg-ui-surface', 'border-ui-line', 'rounded-ui-lg']));
  });

  it('can name its landmark after the heading inside', () => {
    render(
      <AuthFrame labelledBy="titulo">
        <h1 id="titulo">Todo listo</h1>
      </AuthFrame>,
    );
    expect(screen.getByRole('main', { name: 'Todo listo' })).toBeTruthy();
  });
});
