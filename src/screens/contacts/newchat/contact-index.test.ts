import { describe, expect, it } from 'vitest';
import type { NodeInfo } from '../../../lib/api';
import { contactIndex } from './contact-index';

const node = (handle: string, extra: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: '7f3a.91c2.0b5e.d4a8',
  has_session: false,
  added_at: 0,
  ...extra,
});
const nodes = (...handles: string[]) => handles.map(handle => node(handle));
/** The index as [letter, names] pairs, easy to compare. */
const shape = (index: ReturnType<typeof contactIndex>) =>
  index.map(({ letter, nodes: list }) => [letter, list.map(n => n.handle)] as const);

describe('contactIndex', () => {
  it('groups the contacts under their first letter, from A to Z', () => {
    expect(shape(contactIndex(nodes('Valentina', 'ana', 'Carlos', 'Andrés', 'Daniela'), '', 'es'))).toEqual([
      ['A', ['ana', 'Andrés']],
      ['C', ['Carlos']],
      ['D', ['Daniela']],
      ['V', ['Valentina']],
    ]);
  });

  it('puts Á under A, and gives Ñ a letter of its own in Spanish', () => {
    expect(shape(contactIndex(nodes('Ñandú', 'Óscar', 'Álvaro', 'Nicolás', 'Ana'), '', 'es'))).toEqual([
      ['A', ['Álvaro', 'Ana']],
      ['N', ['Nicolás']],
      ['Ñ', ['Ñandú']],
      ['O', ['Óscar']],
    ]);
  });

  it('keeps Ñ under N in English and Portuguese, which have no such letter', () => {
    for (const lang of ['en', 'pt'] as const) {
      expect(shape(contactIndex(nodes('Ñandú', 'Nicolás', 'Óscar'), '', lang)), lang).toEqual([
        ['N', ['Ñandú', 'Nicolás']],
        ['O', ['Óscar']],
      ]);
    }
  });

  it('reads a decomposed Ñ as the same letter', () => {
    expect(shape(contactIndex(nodes('Ñandú'), '', 'es'))).toEqual([['Ñ', ['Ñandú']]]);
  });

  it('puts names that start with no letter under #, at the end', () => {
    const index = contactIndex(nodes('Zoe', '42 Pizza', '🐦 Pío', '@ana', 'Ömer'), '', 'es');
    expect(index.map(group => group.letter)).toEqual(['O', 'Z', '#']);
    expect(index[2]!.nodes.map(n => n.handle).sort()).toEqual(['42 Pizza', '@ana', '🐦 Pío'].sort());
  });

  it('sorts as the language does: case and accents do not split names, numbers count as numbers', () => {
    expect(shape(contactIndex(nodes('ana 10', 'Ana 2', 'ána 1', 'Abril'), '', 'es'))).toEqual([
      ['A', ['Abril', 'ána 1', 'Ana 2', 'ana 10']],
    ]);
  });

  it('filters by name, ignoring accents, case and the spaces around the search', () => {
    const contacts = nodes('José', 'Joselyn', 'María', 'Ñandú');
    expect(shape(contactIndex(contacts, '  jose ', 'es'))).toEqual([['J', ['José', 'Joselyn']]]);
    expect(shape(contactIndex(contacts, 'MARIA', 'es'))).toEqual([['M', ['María']]]);
    expect(shape(contactIndex(contacts, 'nandu', 'es'))).toEqual([['Ñ', ['Ñandú']]]);
    expect(shape(contactIndex(contacts, 'rí', 'es'))).toEqual([['M', ['María']]]);
  });

  it('leaves blocked contacts out, with or without a search', () => {
    const contacts = [node('Ana', { blocked: true }), node('Andrea'), node('Bruno', { blocked: false })];
    expect(shape(contactIndex(contacts, '', 'es'))).toEqual([
      ['A', ['Andrea']],
      ['B', ['Bruno']],
    ]);
    expect(contactIndex(contacts, 'ana', 'es')).toEqual([]);
  });

  it('also matches the other name an alias gives, with or without its @', () => {
    const alias = (handle: string) => (handle === 'Carlos' ? 'carlitos_99' : undefined);
    const contacts = nodes('Carlos', 'Camila');
    expect(shape(contactIndex(contacts, 'carlitos', 'es', alias))).toEqual([['C', ['Carlos']]]);
    expect(shape(contactIndex(contacts, '@carlitos', 'es', alias))).toEqual([['C', ['Carlos']]]);
    expect(contactIndex(contacts, 'carlitos', 'es')).toEqual([]);
  });

  it('gives no letters when nobody matches', () => {
    expect(contactIndex(nodes('Ana', 'Bruno'), 'zzz', 'es')).toEqual([]);
    expect(contactIndex([], '', 'es')).toEqual([]);
  });
});
