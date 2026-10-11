// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveDraft, setDraft, useDrafts } from './drafts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('drafts', () => {
  it('keep one draft per conversation, and drop it when emptied', () => {
    let drafts = setDraft(new Map(), 'Ana', 'Mañana te confirmo');
    drafts = setDraft(drafts, 'grp:g1', 'Llevo el pan');
    expect(drafts.get('Ana')).toBe('Mañana te confirmo');
    expect(drafts.get('grp:g1')).toBe('Llevo el pan');
    // Spaces are part of what is being typed.
    expect(setDraft(drafts, 'Ana', '  ').get('Ana')).toBe('  ');
    expect(setDraft(drafts, 'Ana', '').has('Ana')).toBe(false);
  });

  it('follow a renamed contact', () => {
    const drafts = moveDraft(new Map([['Ana', 'hola']]), 'Ana', 'Ana Torres');
    expect([...drafts]).toEqual([['Ana Torres', 'hola']]);
    expect(moveDraft(drafts, 'nadie', 'otro')).toBe(drafts);
  });

  it('live only in memory: nothing is written to storage, and they are gone once unmounted', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderHook(() => useDrafts());
    act(() => first.result.current.setDraft('Ana', 'texto a medias'));
    act(() => first.result.current.setDraft('Bea', 'otro'));
    expect(first.result.current.drafts.get('Ana')).toBe('texto a medias');
    expect(first.result.current.drafts.get('Bea')).toBe('otro');
    first.unmount();

    const second = renderHook(() => useDrafts());
    expect(second.result.current.drafts.size).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
  });
});
