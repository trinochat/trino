// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autosizeRows, contentRows } from './autosize';
import { Field } from './Field';
import { Textarea } from './Textarea';

afterEach(cleanup);

describe('contentRows', () => {
  it('counts the line breaks when there is no layout to measure', () => {
    expect(contentRows('')).toBe(1);
    expect(contentRows('una\ndos\ntres')).toBe(3);
  });

  it('measures soft-wrapped lines from the scroll height', () => {
    // Three lines of 24 px plus 9 px of padding above and below.
    expect(contentRows('una sola línea muy larga', { scrollHeight: 90, lineHeight: 24, paddingBlock: 18 })).toBe(3);
  });

  it('absorbs sub-pixel rounding of the scroll height', () => {
    expect(contentRows('dos líneas', { scrollHeight: 66.4, lineHeight: 24, paddingBlock: 18 })).toBe(2);
  });

  it('falls back to the line breaks when the metrics are unusable', () => {
    expect(contentRows('a\nb', { scrollHeight: 0, lineHeight: 24, paddingBlock: 18 })).toBe(2);
    expect(contentRows('a\nb', { scrollHeight: 90, lineHeight: Number.NaN, paddingBlock: 18 })).toBe(2);
  });
});

describe('autosizeRows', () => {
  it('stays between minRows and maxRows', () => {
    expect(autosizeRows('', 2, 6)).toBe(2);
    expect(autosizeRows('1\n2\n3', 1, 6)).toBe(3);
    expect(autosizeRows('1\n2\n3\n4\n5\n6\n7\n8', 1, 6)).toBe(6);
  });

  it('never goes below one row, nor lets maxRows undercut minRows', () => {
    expect(autosizeRows('', 0, 4)).toBe(1);
    expect(autosizeRows('1\n2\n3\n4', 3, 1)).toBe(3);
  });
});

describe('Textarea', () => {
  it('grows and shrinks with a controlled value, within its bounds', () => {
    const element = (value: string) => (
      <Textarea aria-label="Mensaje" minRows={1} maxRows={4} value={value} onChange={() => {}} />
    );
    const { rerender } = render(element(''));
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mensaje' });
    expect(box.rows).toBe(1);
    rerender(element('uno\ndos\ntres'));
    expect(box.rows).toBe(3);
    rerender(element('1\n2\n3\n4\n5\n6'));
    expect(box.rows).toBe(4);
    rerender(element(''));
    expect(box.rows).toBe(1);
  });

  it('grows while typing when uncontrolled', () => {
    render(<Textarea aria-label="Notas" minRows={2} maxRows={5} />);
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Notas' });
    expect(box.rows).toBe(2);
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(box.rows).toBe(3);
  });

  it('scrolls only past maxRows', () => {
    const { rerender } = render(<Textarea aria-label="Mensaje" maxRows={2} value="a" onChange={() => {}} />);
    const box = screen.getByRole('textbox', { name: 'Mensaje' });
    expect(box.style.overflowY).toBe('hidden');
    rerender(<Textarea aria-label="Mensaje" maxRows={2} value={'a\nb\nc'} onChange={() => {}} />);
    expect(box.style.overflowY).toBe('auto');
  });

  it('passes onKeyDown and onChange through, so Enter can send', () => {
    const onKeyDown = vi.fn();
    const onChange = vi.fn();
    render(<Textarea aria-label="Mensaje" onKeyDown={onKeyDown} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: 'Mensaje' });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.change(box, { target: { value: 'hola' } });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onKeyDown.mock.calls[0][0].shiftKey).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('forwards the ref and takes its label from a Field', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <Field label="Pega el código de la otra persona">
        <Textarea ref={ref} mono />
      </Field>,
    );
    const box = screen.getByRole('textbox', { name: 'Pega el código de la otra persona' });
    expect(ref.current).toBe(box);
    expect(box.classList).toContain('font-ui-mono');
    expect(box.classList).toContain('resize-none');
  });
});
