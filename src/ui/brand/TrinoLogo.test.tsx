// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrinoLogo } from './TrinoLogo';

afterEach(cleanup);

/** The one `svg` the logo renders. */
function logo(container: HTMLElement): SVGSVGElement {
  const svgs = container.querySelectorAll('svg');
  expect(svgs).toHaveLength(1);
  return svgs[0];
}

describe('TrinoLogo', () => {
  it('is an image named "Trino" by default', () => {
    const { container } = render(<TrinoLogo />);
    expect(screen.getByRole('img', { name: 'Trino' })).toBe(logo(container));
  });

  it('takes another accessible name through title', () => {
    render(<TrinoLogo title="Trino, inicio" />);
    expect(screen.getByRole('img', { name: 'Trino, inicio' })).toBeTruthy();
  });

  it('is hidden from screen readers when it is decoration beside a visible name', () => {
    const { container } = render(<TrinoLogo decorative />);
    const svg = logo(container);
    expect(screen.queryByRole('img')).toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('role')).toBe(false);
    expect(svg.hasAttribute('aria-label')).toBe(false);
  });

  it('fills a square box of the given size, 32 px by default, keeping its proportions', () => {
    const sized = logo(render(<TrinoLogo size={36} />).container);
    expect([sized.getAttribute('width'), sized.getAttribute('height')]).toEqual(['36', '36']);
    expect(sized.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').toBe('xMidYMid meet');
    cleanup();
    const plain = logo(render(<TrinoLogo />).container);
    expect([plain.getAttribute('width'), plain.getAttribute('height')]).toEqual(['32', '32']);
  });

  it('takes its colour from the text around it and has none of its own', () => {
    const svg = logo(render(<TrinoLogo className="text-ui-accent-text" />).container);
    const painted = [svg, ...svg.querySelectorAll('*')];
    const paints = painted.flatMap(node =>
      ['fill', 'stroke', 'color', 'style'].filter(name => node.hasAttribute(name)).map(name => `${name}=${node.getAttribute(name)}`),
    );
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.filter(paint => !/^(fill|stroke)=(currentColor|none)$/.test(paint))).toEqual([]);
    expect(svg.getAttribute('class')?.split(/\s+/)).toContain('text-ui-accent-text');
  });

  it('draws the letters as outlines, so it needs no font', () => {
    const svg = logo(render(<TrinoLogo />).container);
    expect(svg.querySelector('text, tspan, use, image, foreignObject')).toBeNull();
    expect(svg.textContent).toBe('');
    const filled = [...svg.querySelectorAll('path')].filter(path => path.getAttribute('fill') === 'currentColor');
    expect(filled).toHaveLength(1);
    // Closed contours of lines and quadratic curves: the "t" and the "r".
    const outline = filled[0].getAttribute('d') ?? '';
    expect(outline).toMatch(/^M[\d.\sLQZM-]+Z$/);
    expect(outline.match(/Z/g)).toHaveLength(2);
  });

  it('draws the trill as one stroke with round ends', () => {
    const svg = logo(render(<TrinoLogo />).container);
    const stroked = [...svg.querySelectorAll('path')].filter(path => path.getAttribute('stroke') === 'currentColor');
    expect(stroked).toHaveLength(1);
    expect(stroked[0].getAttribute('fill')).toBe('none');
    expect(stroked[0].getAttribute('stroke-linecap')).toBe('round');
    // A wave: one quadratic hump and then its smooth repeats.
    expect(stroked[0].getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+ q[\d.]+ -[\d.]+ [\d.]+ 0( t[\d.]+ 0)+$/);
  });
});
