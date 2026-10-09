import { describe, expect, it } from 'vitest';
import { rovingIndex, tabStopIndex } from './roving';

const ALL_ENABLED = [false, false, false];

describe('rovingIndex', () => {
  it('moves to the next and the previous item, wrapping around', () => {
    expect(rovingIndex('ArrowRight', 0, ALL_ENABLED, 'horizontal')).toBe(1);
    expect(rovingIndex('ArrowRight', 2, ALL_ENABLED, 'horizontal')).toBe(0);
    expect(rovingIndex('ArrowLeft', 1, ALL_ENABLED, 'horizontal')).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, ALL_ENABLED, 'horizontal')).toBe(2);
  });

  it('only follows the arrows of its orientation', () => {
    expect(rovingIndex('ArrowDown', 0, ALL_ENABLED, 'horizontal')).toBeNull();
    expect(rovingIndex('ArrowRight', 0, ALL_ENABLED, 'vertical')).toBeNull();
    expect(rovingIndex('ArrowDown', 0, ALL_ENABLED, 'vertical')).toBe(1);
    expect(rovingIndex('ArrowUp', 0, ALL_ENABLED, 'vertical')).toBe(2);
    expect(rovingIndex('ArrowDown', 0, ALL_ENABLED, 'both')).toBe(1);
    expect(rovingIndex('ArrowRight', 0, ALL_ENABLED, 'both')).toBe(1);
    expect(rovingIndex('ArrowUp', 1, ALL_ENABLED, 'both')).toBe(0);
    expect(rovingIndex('ArrowLeft', 1, ALL_ENABLED, 'both')).toBe(0);
  });

  it('goes to the first and the last item with Home and End', () => {
    expect(rovingIndex('Home', 2, ALL_ENABLED, 'horizontal')).toBe(0);
    expect(rovingIndex('End', 0, ALL_ENABLED, 'vertical')).toBe(2);
  });

  it('skips disabled items', () => {
    const middleOff = [false, true, false];
    expect(rovingIndex('ArrowRight', 0, middleOff, 'horizontal')).toBe(2);
    expect(rovingIndex('ArrowLeft', 2, middleOff, 'horizontal')).toBe(0);
    expect(rovingIndex('Home', 2, [true, false, false], 'both')).toBe(1);
    expect(rovingIndex('End', 0, [false, false, true], 'both')).toBe(1);
  });

  it('stays put when no other item is enabled', () => {
    expect(rovingIndex('ArrowRight', 1, [true, false, true], 'horizontal')).toBe(1);
  });

  it('ignores other keys and groups with nothing enabled', () => {
    expect(rovingIndex('Enter', 0, ALL_ENABLED, 'both')).toBeNull();
    expect(rovingIndex('a', 0, ALL_ENABLED, 'both')).toBeNull();
    expect(rovingIndex('Home', 0, [true, true], 'both')).toBeNull();
  });
});

describe('tabStopIndex', () => {
  it('is the selected item when it is enabled', () => {
    expect(tabStopIndex(2, ALL_ENABLED)).toBe(2);
  });

  it('is the first enabled item when nothing is selected or the selected item is disabled', () => {
    expect(tabStopIndex(-1, ALL_ENABLED)).toBe(0);
    expect(tabStopIndex(-1, [true, false, false])).toBe(1);
    expect(tabStopIndex(0, [true, false, false])).toBe(1);
  });

  it('is -1 when nothing is enabled', () => {
    expect(tabStopIndex(-1, [true, true])).toBe(-1);
  });
});
