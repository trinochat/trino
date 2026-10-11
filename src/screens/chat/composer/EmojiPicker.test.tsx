// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderIn } from '../test-utils';
import { EMOJI_COLUMNS, EMOJI_GROUPS } from './emoji-data';
import { EmojiPicker, detectPlatform } from './EmojiPicker';

afterEach(cleanup);

const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
const ALL = EMOJI_GROUPS.flatMap(group => group.emojis);

/**
 * Enter or Space on the focused button, as a browser presses it: jsdom has
 * no default actions, so the click a browser makes of a key nobody stopped
 * is made here, on keydown for Enter and on keyup for Space.
 */
function pressButton(key: 'Enter' | ' ') {
  const target = document.activeElement!;
  const down = fireEvent.keyDown(target, { key });
  const up = key === ' ' ? fireEvent.keyUp(target, { key }) : true;
  if (target instanceof HTMLButtonElement && down && up) fireEvent.click(target);
}

describe('the curated emoji', () => {
  it('fill whole rows in every group, so the arrows go straight up and down', () => {
    for (const group of EMOJI_GROUPS) {
      expect(group.emojis.length % EMOJI_COLUMNS, group.id).toBe(0);
    }
  });

  it('never repeat', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });
});

describe('EmojiPicker', () => {
  it('names each group and puts the focus on the first emoji', () => {
    renderIn(<EmojiPicker platform="other" onPick={() => {}} />);
    expect(screen.getByRole('group', { name: 'Caras' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Símbolos' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe(ALL[0]);
  });

  it('is one Tab stop, and the arrows, Home and End move through the emoji', () => {
    renderIn(<EmojiPicker platform="other" onPick={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.filter(button => button.tabIndex === 0)).toHaveLength(1);
    press('ArrowRight');
    expect(document.activeElement?.textContent).toBe(ALL[1]);
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe(ALL[1 + EMOJI_COLUMNS]);
    press('ArrowLeft');
    expect(document.activeElement?.textContent).toBe(ALL[EMOJI_COLUMNS]);
    press('ArrowUp');
    expect(document.activeElement?.textContent).toBe(ALL[0]);
    press('End');
    expect(document.activeElement?.textContent).toBe(ALL[ALL.length - 1]);
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe(ALL[ALL.length - 1]);
    press('Home');
    expect(document.activeElement?.textContent).toBe(ALL[0]);
    expect(buttons.filter(button => button.tabIndex === 0)).toHaveLength(1);
  });

  it('crosses from one group to the next with the arrows', () => {
    renderIn(<EmojiPicker platform="other" onPick={() => {}} />);
    const firstGroup = EMOJI_GROUPS[0]!.emojis.length;
    for (let row = 0; row < firstGroup / EMOJI_COLUMNS; row += 1) press('ArrowDown');
    expect(document.activeElement?.textContent).toBe(ALL[firstGroup]);
    expect(within(screen.getByRole('group', { name: 'Gestos' })).getByText(ALL[firstGroup]!)).toBe(document.activeElement);
  });

  it('gives the chosen emoji to the composer, by click or by keyboard', () => {
    const onPick = vi.fn();
    renderIn(<EmojiPicker platform="other" onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: ALL[2] }));
    expect(onPick).toHaveBeenLastCalledWith(ALL[2]);
    // The arrows reach an emoji, and Enter or Space puts it in the message.
    press('ArrowDown');
    press('ArrowRight');
    pressButton('Enter');
    expect(onPick).toHaveBeenLastCalledWith(ALL[EMOJI_COLUMNS + 1]);
    press('ArrowRight');
    pressButton(' ');
    expect(onPick).toHaveBeenLastCalledWith(ALL[EMOJI_COLUMNS + 2]);
    expect(onPick).toHaveBeenCalledTimes(3);
  });

  it("mentions the system's own emoji panel where there is one", () => {
    renderIn(<EmojiPicker platform="windows" onPick={() => {}} />);
    expect(screen.getByText('En Windows tienes todos los emojis con Win + . (punto).')).toBeTruthy();
    cleanup();
    renderIn(<EmojiPicker platform="mac" onPick={() => {}} />);
    expect(screen.getByText('En Mac tienes todos los emojis con Control + Comando + Espacio.')).toBeTruthy();
    cleanup();
    renderIn(<EmojiPicker platform="other" onPick={() => {}} />);
    expect(screen.queryByText(/Win \+|Comando/)).toBeNull();
  });
});

describe('detectPlatform', () => {
  it('tells Windows and Mac apart by the webview, and nothing else', () => {
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/129' })).toBe('windows');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit' })).toBe('mac');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit' })).toBe('other');
  });
});
