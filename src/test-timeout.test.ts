import { TestRunner, beforeAll, describe, expect, it } from 'vitest';

// With eight units building at once the machine gets loaded, and the jsdom
// tests of IconButton, Tabs and Textarea went past vitest's default 5 s
// (trino-rediseno.md:90). The limit is 20 s for tests and hooks.

/**
 * Where vitest 5 keeps the time limit it gave a `beforeAll` hook. Not a public
 * name: if an upgrade of vitest moves it, this test fails with `undefined`
 * and needs the new place, not a lower limit.
 */
const HOOK_TIMEOUT = Symbol.for('VITEST_CLEANUP_TIMEOUT');

describe('the vitest time limits', () => {
  it('give every test 20 s', ({ task }) => {
    expect(task.timeout).toBe(20_000);
  });

  // The limit the runner gave a real hook, so a `--hookTimeout` on the
  // command line or another config shows up here, not only a typo.
  describe('for hooks', () => {
    beforeAll(() => {});

    it('give every hook 20 s too', ({ task }) => {
      const [hook] = TestRunner.getSuiteHooks(task.suite!).beforeAll as unknown as Array<Record<symbol, unknown>>;
      expect(hook[HOOK_TIMEOUT]).toBe(20_000);
    });
  });
});
