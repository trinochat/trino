/**
 * Generates the SAS v2 symbol table (docs/sas-v2.md) from lucide-react:
 *
 *   assets/sas/sas-v2.json         the 64 symbols: lucide name, SVG nodes and words in es/en/pt
 *   assets/sas/LICENSE-lucide.txt  the ISC notice of Lucide, which the drawings carry
 *
 * The JSON is the single source for the desktop app, the mobile app and the
 * website, so it is committed; src/lib/sas-symbols.test.ts rebuilds it in
 * memory and fails if the committed file drifts from what this script makes.
 *
 *   node scripts/gen-sas-assets.mjs
 *
 * The table below is frozen: it is part of the human protocol, so changing an
 * entry, its order or a word is a new SAS version, never an edit.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lucide from 'lucide-react';

export const LUCIDE_VERSION = '0.468.0';

/** index → [lucide component, es, en, pt]. Plan §6. */
export const FROZEN_TABLE = Object.freeze([
  ['Cat', 'Gato', 'Cat', 'Gato'],
  ['Dog', 'Perro', 'Dog', 'Cachorro'],
  ['Fish', 'Pez', 'Fish', 'Peixe'],
  ['Bird', 'Pájaro', 'Bird', 'Pássaro'],
  ['Rabbit', 'Conejo', 'Rabbit', 'Coelho'],
  ['Turtle', 'Tortuga', 'Turtle', 'Tartaruga'],
  ['Snail', 'Caracol', 'Snail', 'Caracol'],
  ['Squirrel', 'Ardilla', 'Squirrel', 'Esquilo'],
  ['Banana', 'Banano', 'Banana', 'Banana'],
  ['Feather', 'Pluma', 'Feather', 'Pena'],
  ['Candy', 'Dulce', 'Candy', 'Doce'],
  ['TreePine', 'Pino', 'Pine tree', 'Pinheiro'],
  ['TreePalm', 'Palmera', 'Palm tree', 'Palmeira'],
  ['Flower2', 'Flor', 'Flower', 'Flor'],
  ['Leaf', 'Hoja', 'Leaf', 'Folha'],
  ['Clover', 'Trébol', 'Clover', 'Trevo'],
  ['Mountain', 'Montaña', 'Mountain', 'Montanha'],
  ['Sun', 'Sol', 'Sun', 'Sol'],
  ['Moon', 'Luna', 'Moon', 'Lua'],
  ['Star', 'Estrella', 'Star', 'Estrela'],
  ['Cloud', 'Nube', 'Cloud', 'Nuvem'],
  ['Citrus', 'Limón', 'Lemon', 'Limão'],
  ['Rainbow', 'Arcoíris', 'Rainbow', 'Arco-íris'],
  ['Zap', 'Rayo', 'Lightning', 'Raio'],
  ['Flame', 'Fuego', 'Fire', 'Fogo'],
  ['Umbrella', 'Paraguas', 'Umbrella', 'Guarda-chuva'],
  ['Milk', 'Leche', 'Milk', 'Leite'],
  ['Cherry', 'Cereza', 'Cherry', 'Cereja'],
  ['Carrot', 'Zanahoria', 'Carrot', 'Cenoura'],
  ['Grape', 'Uvas', 'Grapes', 'Uvas'],
  ['Pizza', 'Pizza', 'Pizza', 'Pizza'],
  ['Coffee', 'Café', 'Coffee', 'Café'],
  ['IceCreamCone', 'Helado', 'Ice cream', 'Sorvete'],
  ['Egg', 'Huevo', 'Egg', 'Ovo'],
  ['Cookie', 'Galleta', 'Cookie', 'Biscoito'],
  ['Popcorn', 'Crispetas', 'Popcorn', 'Pipoca'],
  ['Soup', 'Sopa', 'Soup', 'Sopa'],
  ['Bike', 'Bicicleta', 'Bicycle', 'Bicicleta'],
  ['Truck', 'Camión', 'Truck', 'Caminhão'],
  ['TrainFront', 'Tren', 'Train', 'Trem'],
  ['Plane', 'Avión', 'Plane', 'Avião'],
  ['Sailboat', 'Velero', 'Sailboat', 'Veleiro'],
  ['Rocket', 'Cohete', 'Rocket', 'Foguete'],
  ['Anchor', 'Ancla', 'Anchor', 'Âncora'],
  ['Guitar', 'Guitarra', 'Guitar', 'Violão'],
  ['Drum', 'Tambor', 'Drum', 'Tambor'],
  ['Watch', 'Reloj', 'Watch', 'Relógio'],
  ['Shirt', 'Camisa', 'Shirt', 'Camisa'],
  ['Glasses', 'Gafas', 'Glasses', 'Óculos'],
  ['Crown', 'Corona', 'Crown', 'Coroa'],
  ['Gift', 'Regalo', 'Gift', 'Presente'],
  ['House', 'Casa', 'House', 'Casa'],
  ['Castle', 'Castillo', 'Castle', 'Castelo'],
  ['Tent', 'Carpa', 'Tent', 'Barraca'],
  ['Book', 'Libro', 'Book', 'Livro'],
  ['Scissors', 'Tijeras', 'Scissors', 'Tesoura'],
  ['Dice5', 'Dado', 'Dice', 'Dado'],
  ['Trophy', 'Trofeo', 'Trophy', 'Troféu'],
  ['Compass', 'Brújula', 'Compass', 'Bússola'],
  ['Magnet', 'Imán', 'Magnet', 'Ímã'],
  ['Hammer', 'Martillo', 'Hammer', 'Martelo'],
  ['Gem', 'Diamante', 'Diamond', 'Diamante'],
  ['Backpack', 'Mochila', 'Backpack', 'Mochila'],
  ['Armchair', 'Sillón', 'Armchair', 'Poltrona'],
].map(row => Object.freeze(row)));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'assets/sas');
const require = createRequire(import.meta.url);

/**
 * The SVG attributes a node may keep: geometry, plus `fill="currentColor"` for
 * the few solid dots (the sound hole of Guitar). Lucide's React `key` is dropped.
 */
const GEOMETRY = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points']);
const allowed = (attr, value) => GEOMETRY.has(attr) || (attr === 'fill' && value === 'currentColor');
const TAGS = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

/** The lucide-react version installed in node_modules. */
export function installedLucideVersion() {
  const pkg = JSON.parse(readFileSync(require.resolve('lucide-react/package.json'), 'utf8'));
  return pkg.version;
}

/**
 * The drawing of one lucide-react icon, as `[tag, attrs]` pairs. Each icon is
 * a forwardRef component whose render passes its `iconNode` to the shared
 * `Icon`; rendering it once without a DOM hands the nodes back unchanged.
 */
function iconNodes(name) {
  const component = lucide[name];
  if (!component || typeof component.render !== 'function') {
    throw new Error(`lucide-react has no icon called ${name}`);
  }
  const nodes = component.render({}, null)?.props?.iconNode;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`no drawing found for ${name}`);
  return nodes.map(([tag, attrs]) => {
    if (!TAGS.has(tag)) throw new Error(`${name}: unexpected <${tag}>`);
    const kept = {};
    for (const [attr, value] of Object.entries(attrs)) {
      if (attr === 'key') continue;
      if (!allowed(attr, value)) throw new Error(`${name}: unexpected ${attr}="${value}" on <${tag}>`);
      kept[attr] = String(value);
    }
    return [tag, kept];
  });
}

/**
 * How lucide draws every icon: the attributes of the `<svg>` its shared `Icon`
 * renders. The table carries them so that no platform falls back to its own
 * defaults (Flutter strokes with butt caps and miter joins, and fills paths
 * black), which would erase the dots drawn as zero-length segments.
 */
function drawingRules() {
  const element = lucide.Cat.render({}, null);
  const svg = element?.type?.render?.(element.props, null)?.props;
  if (!svg) throw new Error('could not read the svg attributes of lucide-react');
  if (svg.stroke !== 'currentColor') throw new Error(`lucide-react strokes with ${svg.stroke}, not currentColor`);
  const { viewBox, strokeWidth, fill, strokeLinecap, strokeLinejoin } = svg;
  return { viewBox, strokeWidth, fill, strokeLinecap, strokeLinejoin };
}

/** Stable, reviewable JSON: one line per node and per word set. */
function formatTable(doc) {
  const out = [
    '{',
    `  "version": ${JSON.stringify(doc.version)},`,
    `  "source": ${JSON.stringify(doc.source)},`,
    `  "viewBox": ${JSON.stringify(doc.viewBox)},`,
    `  "strokeWidth": ${JSON.stringify(doc.strokeWidth)},`,
    `  "fill": ${JSON.stringify(doc.fill)},`,
    `  "strokeLinecap": ${JSON.stringify(doc.strokeLinecap)},`,
    `  "strokeLinejoin": ${JSON.stringify(doc.strokeLinejoin)},`,
    '  "symbols": [',
  ];
  doc.symbols.forEach((symbol, i) => {
    out.push('    {');
    out.push(`      "index": ${symbol.index},`);
    out.push(`      "lucide": ${JSON.stringify(symbol.lucide)},`);
    out.push('      "nodes": [');
    symbol.nodes.forEach((node, j) => {
      out.push(`        ${JSON.stringify(node)}${j < symbol.nodes.length - 1 ? ',' : ''}`);
    });
    out.push('      ],');
    out.push(`      "words": ${JSON.stringify(symbol.words)}`);
    out.push(`    }${i < doc.symbols.length - 1 ? ',' : ''}`);
  });
  out.push('  ]', '}', '');
  return out.join('\n');
}

/** Builds both files in memory. Throws if lucide-react is not the pinned version. */
export function buildSasAssets() {
  const version = installedLucideVersion();
  if (version !== LUCIDE_VERSION) {
    throw new Error(`lucide-react ${version} is installed; the SAS v2 table is drawn from ${LUCIDE_VERSION}`);
  }
  const rules = drawingRules();
  const doc = {
    version: 2,
    source: `lucide-react@${LUCIDE_VERSION}`,
    viewBox: rules.viewBox,
    strokeWidth: rules.strokeWidth,
    fill: rules.fill,
    strokeLinecap: rules.strokeLinecap,
    strokeLinejoin: rules.strokeLinejoin,
    symbols: FROZEN_TABLE.map(([name, es, en, pt], index) => ({
      index,
      lucide: name,
      nodes: iconNodes(name),
      words: { es, en, pt },
    })),
  };
  const json = formatTable(doc);
  if (JSON.stringify(JSON.parse(json)) !== JSON.stringify(doc)) throw new Error('formatTable lost data');

  const notice = readFileSync(resolve(dirname(require.resolve('lucide-react/package.json')), 'LICENSE'), 'utf8');
  const license =
    `The icon drawings in sas-v2.json come from Lucide (lucide-react ${LUCIDE_VERSION},\n` +
    'https://lucide.dev), used under the ISC License below.\n\n' +
    `${notice.replace(/\r\n/g, '\n').trimEnd()}\n`;
  return { json, license };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { json, license } = buildSasAssets();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'sas-v2.json'), json);
  writeFileSync(resolve(OUT_DIR, 'LICENSE-lucide.txt'), license);
  console.log(`wrote ${resolve(OUT_DIR, 'sas-v2.json')} and LICENSE-lucide.txt`);
}
