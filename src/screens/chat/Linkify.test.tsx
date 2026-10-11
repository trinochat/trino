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

  it('shows a text without addresses as it is', () => {
    const { container } = render(<Linkify text={'Hola\nqué tal'} onOpenLink={() => {}} />);
    expect(container.textContent).toBe('Hola\nqué tal');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
