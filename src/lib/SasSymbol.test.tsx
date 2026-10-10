// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lang } from './i18n';
import { LangCtx } from './i18n-context';
import { SasIcon, SasSymbol } from './SasSymbol';
import { SAS_SYMBOLS, SAS_TABLE } from './sas-symbols';

afterEach(cleanup);

function inLang(lang: Lang, node: ReactNode) {
  return <LangCtx.Provider value={{ lang, setLang: () => {} }}>{node}</LangCtx.Provider>;
}

describe('SasIcon', () => {
  it('draws the outline of the table entry in the text colour', () => {
    const { container } = render(<SasIcon index={0} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe(SAS_TABLE.viewBox);
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
    expect(svg.getAttribute('data-sas')).toBe('Cat');
  });

  it('takes its drawing rules from the table, like every other platform', () => {
    const { container } = render(<SasIcon index={56} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('fill')).toBe(SAS_TABLE.fill);
    expect(svg.getAttribute('stroke-width')).toBe(String(SAS_TABLE.strokeWidth));
    expect(svg.getAttribute('stroke-linecap')).toBe(SAS_TABLE.strokeLinecap);
    expect(svg.getAttribute('stroke-linejoin')).toBe(SAS_TABLE.strokeLinejoin);
  });

  it('draws every node of every symbol, with its attributes', () => {
    for (const symbol of SAS_SYMBOLS) {
      const { container, unmount } = render(<SasIcon index={symbol.index} />);
      const children = Array.from(container.querySelector('svg')!.children);
      expect(children).toHaveLength(symbol.nodes.length);
      symbol.nodes.forEach(([tag, attrs], i) => {
        expect(children[i]!.tagName.toLowerCase()).toBe(tag);
        for (const [name, value] of Object.entries(attrs)) expect(children[i]!.getAttribute(name)).toBe(value);
      });
      unmount();
    }
  });

  it('is decoration: hidden from screen readers, which read the word instead', () => {
    const { container } = render(<SasIcon index={5} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
  });

  it('grows with the text by default: 1.25em, 20 px at 16 px text', () => {
    const { container } = render(<SasIcon index={1} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('1.25em');
    expect(svg.getAttribute('height')).toBe('1.25em');
  });

  it('takes a size in px or as any CSS length', () => {
    const { container, rerender } = render(<SasIcon index={1} size={28} />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('28');
    expect(container.querySelector('svg')!.getAttribute('height')).toBe('28');
    rerender(<SasIcon index={1} size="1.75rem" />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('1.75rem');
    expect(container.querySelector('svg')!.getAttribute('height')).toBe('1.75rem');
  });
});

describe('SasSymbol', () => {
  it('shows the word in the current language', () => {
    render(inLang('es', <SasSymbol index={1} />));
    expect(screen.getByText('Perro')).toBeTruthy();
    cleanup();
    render(inLang('pt', <SasSymbol index={1} />));
    expect(screen.getByText('Cachorro')).toBeTruthy();
    cleanup();
    render(inLang('en', <SasSymbol index={1} />));
    expect(screen.getByText('Dog')).toBeTruthy();
  });

  it('can be given a language of its own', () => {
    render(inLang('en', <SasSymbol index={8} lang="es" />));
    expect(screen.getByText('Banano')).toBeTruthy();
  });

  it('tags the word with its language, so a screen reader uses the right voice', () => {
    render(inLang('en', <SasSymbol index={8} lang="es" />));
    expect(screen.getByText('Banano').getAttribute('lang')).toBe('es');
    cleanup();
    render(inLang('pt', <SasSymbol index={1} />));
    expect(screen.getByText('Cachorro').getAttribute('lang')).toBe('pt');
  });

  it('sizes its icon with the text by default', () => {
    const { container } = render(inLang('es', <SasSymbol index={3} />));
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('1.25em');
  });

  it('draws the icon beside the word', () => {
    const { container } = render(inLang('es', <SasSymbol index={44} size={16} />));
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-sas')).toBe('Guitar');
    expect(svg.getAttribute('width')).toBe('16');
    expect(container.textContent).toBe('Guitarra');
  });
});
