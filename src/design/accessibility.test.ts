import { describe, expect, it, vi } from 'vitest';
import {
  ACCESSIBILITY_STORAGE_KEY,
  CONTRASTS,
  DEFAULT_ACCESSIBILITY,
  LEGACY_TEXT_SIZE_STORAGE_KEY,
  TEXT_SCALES,
  VISIONS,
  loadAccessibility,
  resolveAccessibility,
  saveAccessibility,
  stepTextScale,
  type Accessibility,
  type SystemSignals,
} from './accessibility';

function memoryStorage(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

const stored = (value: unknown) => memoryStorage({ [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify(value) });

const QUIET_SYSTEM: SystemSignals = { textScale: 1, moreContrast: false, reducedMotion: false, forcedColors: false };

describe('the accessibility settings', () => {
  it('offer 100 to 200 % of text, nothing below 100 %', () => {
    expect(TEXT_SCALES).toEqual([1, 1.1, 1.25, 1.5, 1.75, 2]);
  });

  it('share the visions and contrasts of the token layers', () => {
    expect(VISIONS).toEqual(['standard', 'safe']);
    expect(CONTRASTS).toEqual(['standard', 'more']);
  });

  it('follow the system by default and change nothing else', () => {
    expect(DEFAULT_ACCESSIBILITY).toEqual({
      textScale: 'system',
      vision: 'standard',
      contrast: 'system',
      motion: 'system',
      spacing: 'standard',
    });
    expect(Object.isFrozen(DEFAULT_ACCESSIBILITY)).toBe(true);
  });
});

describe('loadAccessibility', () => {
  it('stores under trino.accessibility, apart from the appearance', () => {
    expect(ACCESSIBILITY_STORAGE_KEY).toBe('trino.accessibility');
  });

  it('gives the defaults when nothing is stored', () => {
    expect(loadAccessibility(memoryStorage())).toEqual(DEFAULT_ACCESSIBILITY);
  });

  it('reads what was stored', () => {
    const value: Accessibility = { textScale: 1.5, vision: 'safe', contrast: 'more', motion: 'reduce', spacing: 'wide' };
    expect(loadAccessibility(stored(value))).toEqual(value);
  });

  it('takes the default for each field it does not know, keeping the others', () => {
    const loaded = loadAccessibility(
      stored({ textScale: 'huge', vision: 'mono', contrast: 'max', motion: 'slow', spacing: 'wide' }),
    );
    expect(loaded).toEqual({ ...DEFAULT_ACCESSIBILITY, spacing: 'wide' });
  });

  it('moves a stored factor that is not a step to the nearest step', () => {
    expect(loadAccessibility(stored({ textScale: 1.3 })).textScale).toBe(1.25);
    expect(loadAccessibility(stored({ textScale: 1.4 })).textScale).toBe(1.5);
    expect(loadAccessibility(stored({ textScale: 0.9 })).textScale).toBe(1);
    expect(loadAccessibility(stored({ textScale: 3 })).textScale).toBe(2);
    expect(loadAccessibility(stored({ textScale: Number.NaN })).textScale).toBe('system');
    expect(loadAccessibility(memoryStorage({ [ACCESSIBILITY_STORAGE_KEY]: '{"textScale":1e999}' })).textScale).toBe(
      'system',
    );
  });

  it('gives the defaults for broken JSON or a value that is not an object', () => {
    expect(loadAccessibility(memoryStorage({ [ACCESSIBILITY_STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_ACCESSIBILITY);
    expect(loadAccessibility(stored([1.5]))).toEqual(DEFAULT_ACCESSIBILITY);
    expect(loadAccessibility(stored(null))).toEqual(DEFAULT_ACCESSIBILITY);
  });

  it('gives the defaults when storage throws, so start-up never breaks', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(loadAccessibility(throwing)).toEqual(DEFAULT_ACCESSIBILITY);
  });

  it('returns a copy, so callers cannot change the defaults', () => {
    const loaded = loadAccessibility(memoryStorage());
    loaded.vision = 'safe';
    expect(DEFAULT_ACCESSIBILITY.vision).toBe('standard');
  });
});

describe('the text size of E0', () => {
  it('was stored as trino.pref.textSize', () => {
    expect(LEGACY_TEXT_SIZE_STORAGE_KEY).toBe('trino.pref.textSize');
  });

  it("migrates 'large' to 125 %", () => {
    const storage = memoryStorage({ [LEGACY_TEXT_SIZE_STORAGE_KEY]: 'large' });
    expect(loadAccessibility(storage)).toEqual({ ...DEFAULT_ACCESSIBILITY, textScale: 1.25 });
  });

  it("migrates 'normal', or anything else, to the system's size", () => {
    expect(loadAccessibility(memoryStorage({ [LEGACY_TEXT_SIZE_STORAGE_KEY]: 'normal' }))).toEqual(DEFAULT_ACCESSIBILITY);
    expect(loadAccessibility(memoryStorage({ [LEGACY_TEXT_SIZE_STORAGE_KEY]: 'huge' }))).toEqual(DEFAULT_ACCESSIBILITY);
  });

  it('writes nothing while it migrates', () => {
    const storage = memoryStorage({ [LEGACY_TEXT_SIZE_STORAGE_KEY]: 'large' });
    loadAccessibility(storage);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('is ignored once the settings are stored', () => {
    const storage = memoryStorage({
      [LEGACY_TEXT_SIZE_STORAGE_KEY]: 'large',
      [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify({ textScale: 'system' }),
    });
    expect(loadAccessibility(storage).textScale).toBe('system');
  });
});

describe('saveAccessibility', () => {
  it('stores the five fields as JSON and reads them back', () => {
    const storage = memoryStorage();
    const value: Accessibility = { textScale: 1.1, vision: 'safe', contrast: 'standard', motion: 'full', spacing: 'wide' };
    expect(saveAccessibility(storage, value)).toBe(true);
    expect(JSON.parse(storage.data.get(ACCESSIBILITY_STORAGE_KEY)!)).toEqual(value);
    expect(loadAccessibility(storage)).toEqual(value);
  });

  it('stores only the known fields, normalised', () => {
    const storage = memoryStorage();
    saveAccessibility(storage, { ...DEFAULT_ACCESSIBILITY, textScale: 1.3, extra: true } as unknown as Accessibility);
    expect(JSON.parse(storage.data.get(ACCESSIBILITY_STORAGE_KEY)!)).toEqual({ ...DEFAULT_ACCESSIBILITY, textScale: 1.25 });
  });

  it('returns false when storage refuses it', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveAccessibility(refusing, DEFAULT_ACCESSIBILITY)).toBe(false);
  });
});

describe('resolveAccessibility', () => {
  it('follows the system where the settings say so', () => {
    expect(
      resolveAccessibility(DEFAULT_ACCESSIBILITY, {
        textScale: 1.25,
        moreContrast: true,
        reducedMotion: true,
        forcedColors: false,
      }),
    ).toEqual({ textScale: 1.25, vision: 'standard', contrast: 'more', motion: 'reduce', spacing: 'standard' });
    expect(resolveAccessibility(DEFAULT_ACCESSIBILITY, QUIET_SYSTEM)).toEqual({
      textScale: 1,
      vision: 'standard',
      contrast: 'standard',
      motion: 'full',
      spacing: 'standard',
    });
  });

  it('keeps what the person chose over the system', () => {
    const chosen: Accessibility = { textScale: 1.75, vision: 'safe', contrast: 'standard', motion: 'full', spacing: 'wide' };
    expect(
      resolveAccessibility(chosen, { textScale: 1.25, moreContrast: true, reducedMotion: true, forcedColors: true }),
    ).toEqual({ textScale: 1.75, vision: 'safe', contrast: 'standard', motion: 'full', spacing: 'wide' });
    expect(resolveAccessibility({ ...chosen, contrast: 'more', motion: 'reduce' }, QUIET_SYSTEM)).toMatchObject({
      contrast: 'more',
      motion: 'reduce',
    });
  });

  // Windows can say 135 %: the system's factor is kept as it is, between 100
  // and 200 %; only a stored factor snaps to a step.
  it("keeps the system's factor between 100 and 200 % without rounding it to a step", () => {
    const at = (textScale: number) => resolveAccessibility(DEFAULT_ACCESSIBILITY, { ...QUIET_SYSTEM, textScale }).textScale;
    expect(at(1.35)).toBe(1.35);
    expect(at(2.25)).toBe(2);
    expect(at(0.8)).toBe(1);
    expect(at(Number.NaN)).toBe(1);
  });
});

describe('stepTextScale', () => {
  it('moves one step up or down, and stays within 100 and 200 %', () => {
    expect(stepTextScale(1, 'up')).toBe(1.1);
    expect(stepTextScale(1.1, 'up')).toBe(1.25);
    expect(stepTextScale(1.75, 'up')).toBe(2);
    expect(stepTextScale(2, 'up')).toBe(2);
    expect(stepTextScale(1.5, 'down')).toBe(1.25);
    expect(stepTextScale(1.1, 'down')).toBe(1);
    expect(stepTextScale(1, 'down')).toBe(1);
  });

  // Windows can say 135 %: the next step is the one past it in that direction.
  it('goes from a factor between steps to the next step in that direction', () => {
    expect(stepTextScale(1.35, 'up')).toBe(1.5);
    expect(stepTextScale(1.35, 'down')).toBe(1.25);
    expect(stepTextScale(2.25, 'down')).toBe(2);
    expect(stepTextScale(0.9, 'up')).toBe(1);
  });
});
