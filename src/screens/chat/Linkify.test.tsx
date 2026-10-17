// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Linkify, splitLinks } from './Linkify';
import { classesOf } from './test-utils';

afterEach(cleanup);

describe('splitLinks', () => {
  it('finds the web addresses in a text and keeps the rest as it is', () => {
    expect(splitLinks('Mira https://trino.chat/novedades y http://example.com/a?b=1 hoy')).toEqual([
      { text: 'Mira ' },
      { text: 'https://trino.chat/novedades', url: 'https://trino.chat/novedades' },
      { text: ' y ' },
      { text: 'http://example.com/a?b=1', url: 'http://example.com/a?b=1' },
      { text: ' hoy' },
    ]);
  });

  it('leaves the punctuation after an address out of it', () => {
    expect(splitLinks('Está en https://trino.chat/x.')).toEqual([
      { text: 'Está en ' },
      { text: 'https://trino.chat/x', url: 'https://trino.chat/x' },
      { text: '.' },
    ]);
    expect(splitLinks('(ver https://trino.chat/y)')[1]).toEqual({ text: 'https://trino.chat/y', url: 'https://trino.chat/y' });
  });

  it('keeps a closing parenthesis that belongs to the address', () => {
    const url = 'https://es.wikipedia.org/wiki/Trino_(m%C3%BAsica)';
    expect(splitLinks(`Lee ${url}, es corto`)[1]).toEqual({ text: url, url });
  });

  // TRN-APP-01: trimming used to recount every parenthesis for each character
  // it removed, so one message of closing parentheses froze the chat for seconds.
  it('TRN-APP-01: trims a long run of closing parentheses in linear time', () => {
    const text = 'https://a.co/' + ')'.repeat(30_000);
    const start = performance.now();
    const parts = splitLinks(text);
    expect(performance.now() - start).toBeLessThan(200);
    expect(parts[0]).toEqual({ text: 'https://a.co/', url: 'https://a.co/' });
    expect(parts.map(part => part.text).join('')).toBe(text);
  });

  it('TRN-APP-01: leaves an address longer than the backend accepts as plain text', () => {
    const text = `Mira https://example.org/${'a'.repeat(4_096)} hoy`;
    expect(splitLinks(text)).toEqual([{ text }]);
    const fits = `https://example.org/${'a'.repeat(4_096 - 'https://example.org/'.length)}`;
    expect(splitLinks(fits)).toEqual([{ text: fits, url: fits }]);
  });

  it('makes links of the web only: no other scheme', () => {
    for (const text of ['javascript:alert(1)', 'ftp://example.com/a', 'file:///C:/x', 'mailto:ana@example.com']) {
      expect(splitLinks(text), text).toEqual([{ text }]);
    }
  });
});

describe('Linkify', () => {
  it('opens a link through onOpenLink, in the system browser, never inside the app', () => {
    const onOpenLink = vi.fn();
    render(<Linkify text="Mira https://trino.chat/novedades" onOpenLink={onOpenLink} />);
    const link = screen.getByRole('link', { name: 'https://trino.chat/novedades' });
    expect(fireEvent.click(link)).toBe(false); // the webview does not navigate
    expect(onOpenLink).toHaveBeenCalledWith('https://trino.chat/novedades');
  });

  it('underlines a link and gives it the colour of the text around it, so it reads in any bubble', () => {
    render(<Linkify text="https://trino.chat" onOpenLink={() => {}} />);
    const classes = classesOf(screen.getByRole('link'));
    expect(classes).toContain('underline');
    expect(classes.filter(name => /^text-ui-/.test(name))).toEqual([]);
    // Its focus ring follows the text too: the accent one vanishes on your own bubble.
    expect(classes).toContain('focus-visible:outline-current');
    expect(classes).not.toContain('focus-visible:outline-ui-accent-text');
  });

  // Design test 60 (Tor design §4, R-10): no href, so the WebView has no
  // address to resolve, prefetch, preconnect or drag, and nothing to follow.
  it('links_render_without_href: a link the keyboard reaches, with no address for the WebView', () => {
    const onOpenLink = vi.fn();
    const { container } = render(<Linkify text="Mira https://example.org/articulo hoy" onOpenLink={onOpenLink} />);
    const link = screen.getByRole('link', { name: 'https://example.org/articulo' });
    expect(link.tagName).toBe('SPAN');
    expect(link.hasAttribute('href')).toBe(false);
    expect(container.querySelector('[href]')).toBeNull();
    expect(link.tabIndex).toBe(0);
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(onOpenLink).toHaveBeenCalledWith('https://example.org/articulo');
    fireEvent.keyDown(link, { key: ' ' });
    expect(onOpenLink).toHaveBeenCalledTimes(1); // a link answers Enter, not Space
    fireEvent.mouseUp(link, { button: 1 });
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onOpenLink).toHaveBeenCalledTimes(2);
  });

  it('shows a text without addresses as it is', () => {
    const { container } = render(<Linkify text={'Hola\nqué tal'} onOpenLink={() => {}} />);
    expect(container.textContent).toBe('Hola\nqué tal');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
