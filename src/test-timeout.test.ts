import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.ts?raw';

// With eight units building at once the machine gets loaded, and the jsdom
// tests of IconButton, Tabs and Textarea went past vitest's default 5 s
// (trino-rediseno.md:90). The limit is 20 s for tests and hooks.
describe('the vitest time limits', () => {
  it('give every test 20 s', ({ task }) => {
    expect(task.timeout).toBe(20_000);
  });

  it('give every hook 20 s too', () => {
    expect(viteConfig).toMatch(/\bhookTimeout:\s*20_000\b/);
  });
});
