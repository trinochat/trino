import { describe, expect, it } from 'vitest';
import { attempt } from './attempt';

describe('attempt', () => {
  it('passes on the promise of a call that returns one', async () => {
    await expect(attempt(() => Promise.resolve(7))).resolves.toBe(7);
    await expect(attempt(() => Promise.reject(new Error('later')))).rejects.toThrow('later');
  });

  it('turns a call that throws at once into a rejected promise', async () => {
    const thrower = (): Promise<number> => {
      throw new Error('at once');
    };
    await expect(attempt(thrower)).rejects.toThrow('at once');
  });
});
