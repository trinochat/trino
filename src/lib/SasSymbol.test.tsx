// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lang } from './i18n';
import { LangCtx } from './i18n-context';
import { SasIcon, SasSymbol, type SasIconProps } from './SasSymbol';
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

  // Older WebKit rejects rem in the width and height of an <svg> and draws
  // it at 100 %: a step of the icon sizes puts px there and rem in a class
  // that beats them. 20 px wherever two people compare symbols, 28 px in the
  // comparison panel (docs/sas-v2.md).
  it('takes a step of the icon sizes: px in the attributes, rem in a class', () => {
    const { container, rerender } = render(<SasIcon index={1} size="2xl" />);
    const svg = () => container.querySelector('svg')!;
    expect([svg().getAttribute('width'), svg().getAttribute('height')]).toEqual(['28', '28']);
    expect(svg().classList).toContain('size-[1.75rem]');
    rerender(<SasIcon index={1} size="lg" className="text-ui-ink" />);
    expect([svg().getAttribute('width'), svg().getAttribute('height')]).toEqual(['20', '20']);
    expect([...svg().classList]).toEqual(['shrink-0', 'size-[1.25rem]', 'text-ui-ink']);
  });

  it('takes no number and no CSS length as its size', () => {
    // @ts-expect-error A number would stay in px.
    const inPx: SasIconProps = { index: 1, size: 28 };
    // @ts-expect-error Older WebKit rejects rem in the attributes.
    const inRem: SasIconProps = { index: 1, size: '1.75rem' };
    expect([inPx.size, inRem.size]).toEqual([28, '1.75rem']);
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

  it('draws the icon beside the word, at the step it is given', () => {
    const { container } = render(inLang('es', <SasSymbol index={44} size="lg" className="text-ui-ink" />));
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-sas')).toBe('Guitar');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.classList).toContain('size-[1.25rem]');
    // The class of SasSymbol is for the pair, not for the icon.
    expect(svg.classList).not.toContain('text-ui-ink');
    expect(container.textContent).toBe('Guitarra');
  });
});
