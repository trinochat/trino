// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLang } from '../test-utils';
import { LanguageSection } from './LanguageSection';

afterEach(cleanup);

// Settings > Idioma (Settings:235-248).
describe('LanguageSection', () => {
  it('picks among the three languages, each named in itself', () => {
    const setLang = vi.fn();
    render(withLang(<LanguageSection />, 'es', setLang));
    const group = screen.getByRole('radiogroup', { name: 'Idioma' });
    const options = within(group).getAllByRole('radio');
    expect(options.map(option => option.textContent)).toEqual(['Español', 'English', 'Português']);
    expect(within(group).getByRole('radio', { name: 'Español' }).getAttribute('aria-checked')).toBe('true');
    expect(within(group).getByRole('radio', { name: 'English' }).getAttribute('lang')).toBe('en');
    fireEvent.click(within(group).getByRole('radio', { name: 'English' }));
    expect(setLang).toHaveBeenCalledWith('en');
  });

  it('says that Trino starts in the language of the system', () => {
    render(withLang(<LanguageSection />));
    expect(screen.getByText('Al empezar, Trino usa el idioma de tu sistema. Puedes cambiarlo aquí cuando quieras.')).toBeTruthy();
  });

  it('marks the language in use', () => {
    render(withLang(<LanguageSection />, 'pt'));
    expect(screen.getByRole('radio', { name: 'Português' }).getAttribute('aria-checked')).toBe('true');
  });
});
