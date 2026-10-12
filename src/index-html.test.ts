// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import { pickLang } from './lib/i18n';

/**
 * index.html as the webview gets it, before any script runs: what a screen
 * reader meets first, and the page main.tsx mounts the app into.
 */
const page = new DOMParser().parseFromString(indexHtml, 'text/html');

describe('index.html', () => {
  // WCAG 3.1.1: the page has a language from its first byte. Until App puts
  // the chosen one on <html> before its first paint (useDocumentLang), it is
  // the one Trino falls back to when nothing is saved and the system speaks
  // no language Trino has.
  it('names the language Trino falls back to', () => {
    expect(page.documentElement.getAttribute('lang')).toBe(pickLang([]));
  });

  // main.tsx marks <html> with the appearance and the accessibility settings
  // before the first render (src/design/apply.ts). A theme of the page's own,
  // like the old data-theme, or a class on <html> or <body>, would fight them.
  it('carries no theme of its own on <html> or <body>', () => {
    expect(page.documentElement.getAttributeNames()).toEqual(['lang']);
    expect(page.body.getAttributeNames()).toEqual([]);
  });
});
