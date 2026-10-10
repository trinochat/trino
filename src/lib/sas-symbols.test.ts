import { describe, expect, it } from 'vitest';
import committedJson from '../../assets/sas/sas-v2.json?raw';
import committedLicense from '../../assets/sas/LICENSE-lucide.txt?raw';
import committedVectors from '../../assets/sas/vectors.json?raw';
import spec from '../../docs/sas-v2.md?raw';
import generatorSource from '../../scripts/gen-sas-assets.mjs?raw';
import vectorsScriptSource from '../../scripts/sas_vectors.py?raw';
import { LUCIDE_VERSION, buildSasAssets, installedLucideVersion } from '../../scripts/gen-sas-assets.mjs';
import type { Lang } from './i18n';
import { SAS_SYMBOLS, SAS_TABLE, sasSymbol, sasWord, sasWords } from './sas-symbols';

/**
 * The frozen SAS v2 table (plan §6, docs/sas-v2.md): lucide icon, then the
 * word in es / en / pt. It is part of the human protocol: both sides of a call
 * must see the same symbol for the same index, on every platform and version.
 * This copy is kept by hand on purpose, so a change to the generator cannot
 * slip through.
 */
const FROZEN = `
Cat: Gato/Cat/Gato
Dog: Perro/Dog/Cachorro
Fish: Pez/Fish/Peixe
Bird: Pájaro/Bird/Pássaro
Rabbit: Conejo/Rabbit/Coelho
Turtle: Tortuga/Turtle/Tartaruga
Snail: Caracol/Snail/Caracol
Squirrel: Ardilla/Squirrel/Esquilo
Banana: Banano/Banana/Banana
Feather: Pluma/Feather/Pena
Candy: Dulce/Candy/Doce
TreePine: Pino/Pine tree/Pinheiro
TreePalm: Palmera/Palm tree/Palmeira
Flower2: Flor/Flower/Flor
Leaf: Hoja/Leaf/Folha
Clover: Trébol/Clover/Trevo
Mountain: Montaña/Mountain/Montanha
Sun: Sol/Sun/Sol
Moon: Luna/Moon/Lua
Star: Estrella/Star/Estrela
Cloud: Nube/Cloud/Nuvem
Citrus: Limón/Lemon/Limão
Rainbow: Arcoíris/Rainbow/Arco-íris
Zap: Rayo/Lightning/Raio
Flame: Fuego/Fire/Fogo
Umbrella: Paraguas/Umbrella/Guarda-chuva
Milk: Leche/Milk/Leite
Cherry: Cereza/Cherry/Cereja
Carrot: Zanahoria/Carrot/Cenoura
Grape: Uvas/Grapes/Uvas
Pizza: Pizza/Pizza/Pizza
Coffee: Café/Coffee/Café
IceCreamCone: Helado/Ice cream/Sorvete
Egg: Huevo/Egg/Ovo
Cookie: Galleta/Cookie/Biscoito
Popcorn: Crispetas/Popcorn/Pipoca
Soup: Sopa/Soup/Sopa
Bike: Bicicleta/Bicycle/Bicicleta
Truck: Camión/Truck/Caminhão
TrainFront: Tren/Train/Trem
Plane: Avión/Plane/Avião
Sailboat: Velero/Sailboat/Veleiro
Rocket: Cohete/Rocket/Foguete
Anchor: Ancla/Anchor/Âncora
Guitar: Guitarra/Guitar/Violão
Drum: Tambor/Drum/Tambor
Watch: Reloj/Watch/Relógio
Shirt: Camisa/Shirt/Camisa
Glasses: Gafas/Glasses/Óculos
Crown: Corona/Crown/Coroa
Gift: Regalo/Gift/Presente
House: Casa/House/Casa
Castle: Castillo/Castle/Castelo
Tent: Carpa/Tent/Barraca
Book: Libro/Book/Livro
Scissors: Tijeras/Scissors/Tesoura
Dice5: Dado/Dice/Dado
Trophy: Trofeo/Trophy/Troféu
Compass: Brújula/Compass/Bússola
Magnet: Imán/Magnet/Ímã
Hammer: Martillo/Hammer/Martelo
Gem: Diamante/Diamond/Diamante
Backpack: Mochila/Backpack/Mochila
Armchair: Sillón/Armchair/Poltrona
`
  .trim()
  .split('\n')
  .map(line => {
    const [lucide, words] = line.split(': ');
    const [es, en, pt] = words!.split('/');
    return { lucide: lucide!, words: { es: es!, en: en!, pt: pt! } };
  });

/**
 * Icons that must never be a SAS symbol: icons that mean something in the UI
 * (a call, a lock, a key, a shield, a bell...), anything violent, medical,
 * creepy-crawly or about death, `Flower` (it looks like `Sun`), anything called
 * `Map`, and the three entries replaced in plan §6 (Shell, PawPrint, Snowflake).
 */
const FORBIDDEN = [
  'Phone', 'PhoneCall', 'PhoneOff', 'Mic', 'MicOff', 'Video', 'Camera', 'Lock', 'LockOpen', 'Unlock',
  'Key', 'KeyRound', 'Shield', 'ShieldCheck', 'ShieldAlert', 'Bell', 'BellOff', 'Check', 'CheckCheck', 'X',
  'Fingerprint', 'Eye', 'EyeOff', 'Wifi', 'Globe', 'Send', 'Mail', 'Settings',
  'Bomb', 'Sword', 'Swords', 'Axe', 'Crosshair', 'Target', 'Skull', 'Ghost', 'Biohazard', 'Radiation',
  'Pill', 'Syringe', 'Droplet', 'Droplets', 'Stethoscope', 'Hospital', 'Ambulance', 'HeartPulse', 'Cross',
  'Bug', 'BugOff', 'Worm', 'Spider', 'Rat', 'Bone',
  'Flower', 'Map', 'MapPin', 'Shell', 'PawPrint', 'Snowflake',
];
/** Name fragments that rule out a whole family of icons. */
const FORBIDDEN_PATTERN = /Map|Phone|Mic|Lock|Key|Shield|Bell|Skull|Bomb|Bug|Pill|Syringe|Sword|Gun/;

const LANGS: Lang[] = ['es', 'en', 'pt'];
/** Lower case without accents, to catch words that differ only in an accent. */
const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The generator only runs against the lucide-react the table was drawn from.
 * The app draws from the committed JSON, so a later lucide-react upgrade (for
 * the UI icons) cannot change the symbols: then only the drift check is
 * skipped, and the committed JSON and the FROZEN copy above stay the guard.
 */
const INSTALLED_LUCIDE = installedLucideVersion();
const CAN_REGENERATE = INSTALLED_LUCIDE === LUCIDE_VERSION;

/**
 * The SVG attributes a node may carry: geometry, never a colour or a stroke of
 * its own. The one exception is `fill="currentColor"`, a solid dot in the text
 * colour (the sound hole of Guitar).
 */
const GEOMETRY = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points']);
const TAGS = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

describe('the SAS v2 table (assets/sas/sas-v2.json)', () => {
  it('declares its version, source and drawing box', () => {
    expect(SAS_TABLE.version).toBe(2);
    expect(SAS_TABLE.source).toBe('lucide-react@0.468.0');
    expect(SAS_TABLE.viewBox).toBe('0 0 24 24');
    expect(SAS_TABLE.strokeWidth).toBe(2);
  });

  it('carries the drawing rules, so no platform falls back to its own defaults', () => {
    // Several icons draw dots as zero-length segments that only show with
    // round caps; Flutter defaults to butt caps, miter joins and black fills.
    expect(SAS_TABLE.fill).toBe('none');
    expect(SAS_TABLE.strokeLinecap).toBe('round');
    expect(SAS_TABLE.strokeLinejoin).toBe('round');
    expect(Object.keys(JSON.parse(committedJson))).toEqual([
      'version', 'source', 'viewBox', 'strokeWidth', 'fill', 'strokeLinecap', 'strokeLinejoin', 'symbols',
    ]);
  });

  it('is exactly the frozen table of plan §6, in order', () => {
    expect(FROZEN).toHaveLength(64);
    expect(SAS_SYMBOLS).toHaveLength(64);
    SAS_SYMBOLS.forEach((symbol, index) => {
      expect(symbol.index).toBe(index);
      expect({ lucide: symbol.lucide, words: symbol.words }).toEqual(FROZEN[index]);
    });
  });

  it('has 64 different icons, by name and by drawing', () => {
    expect(new Set(SAS_SYMBOLS.map(s => s.lucide)).size).toBe(64);
    expect(new Set(SAS_SYMBOLS.map(s => JSON.stringify(s.nodes))).size).toBe(64);
  });

  it.each(LANGS)('has 64 different words in %s, each with a capital first letter', lang => {
    const words = SAS_SYMBOLS.map(s => s.words[lang]);
    expect(new Set(words.map(fold)).size).toBe(64);
    for (const word of words) {
      expect(word).toBe(word.trim());
      expect(word).not.toMatch(/\s{2}/);
      const first = word[0]!;
      expect(first).toBe(first.toLocaleUpperCase(lang));
      expect(first).not.toBe(first.toLocaleLowerCase(lang));
    }
  });

  it('has none of the forbidden icons', () => {
    for (const symbol of SAS_SYMBOLS) {
      expect(FORBIDDEN).not.toContain(symbol.lucide);
      expect(symbol.lucide).not.toMatch(FORBIDDEN_PATTERN);
    }
  });

  it('draws with plain geometry, so every platform strokes it with the text colour', () => {
    for (const symbol of SAS_SYMBOLS) {
      expect(symbol.nodes.length).toBeGreaterThan(0);
      for (const [tag, attrs] of symbol.nodes) {
        expect(TAGS).toContain(tag);
        for (const [name, value] of Object.entries(attrs)) {
          expect(typeof value).toBe('string');
          if (name === 'fill') expect(value, `${symbol.lucide} <${tag} fill>`).toBe('currentColor');
          else expect(GEOMETRY, `${symbol.lucide} <${tag} ${name}>`).toContain(name);
        }
      }
    }
  });

  it('is drawn from the lucide-react version the generator pins', () => {
    expect(SAS_TABLE.source).toBe(`lucide-react@${LUCIDE_VERSION}`);
    expect(INSTALLED_LUCIDE).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.skipIf(!CAN_REGENERATE)(
    CAN_REGENERATE
      ? 'matches what the generator makes from lucide-react today (no drift)'
      : `drift check skipped: lucide-react ${INSTALLED_LUCIDE} is installed, the table is drawn from ${LUCIDE_VERSION}`,
    () => {
      const fresh = buildSasAssets();
      expect(committedJson).toBe(fresh.json);
      expect(committedLicense).toBe(fresh.license);
    },
  );

  it('is listed row for row in docs/sas-v2.md', () => {
    for (const s of SAS_SYMBOLS) {
      expect(spec).toContain(`| ${s.index} | ${s.lucide} | ${s.words.es} | ${s.words.en} | ${s.words.pt} |`);
    }
  });

  it('ships the ISC notice of Lucide beside the drawings', () => {
    expect(committedLicense).toContain('ISC License');
    expect(committedLicense).toContain('Lucide Contributors');
    expect(committedLicense).toContain('sas-v2.json');
  });
});

/**
 * The mobile app keeps byte-identical copies of the JSON files, and the
 * scripts must rebuild them byte for byte. So every checkout must give the
 * committed bytes, whatever `core.autocrlf` says: .gitattributes pins these
 * files to LF.
 */
const SHARED_FILES: Record<string, string> = {
  'assets/sas/sas-v2.json': committedJson,
  'assets/sas/vectors.json': committedVectors,
  'assets/sas/LICENSE-lucide.txt': committedLicense,
  'docs/sas-v2.md': spec,
  'scripts/gen-sas-assets.mjs': generatorSource,
  'scripts/sas_vectors.py': vectorsScriptSource,
};

describe('the shared SAS files', () => {
  it.each(Object.entries(SHARED_FILES))('%s is checked out exactly as committed: LF only, no BOM', (file, text) => {
    expect(text.includes('\r'), `${file} has CR line endings (see .gitattributes)`).toBe(false);
    expect(text.startsWith('﻿'), `${file} starts with a BOM`).toBe(false);
  });
});

describe('lookups', () => {
  it('finds a symbol and its word by index', () => {
    expect(sasSymbol(0).lucide).toBe('Cat');
    expect(sasWord(8, 'es')).toBe('Banano');
    expect(sasWord(10, 'en')).toBe('Candy');
    expect(sasWord(21, 'pt')).toBe('Limão');
    expect(sasWords([0, 1, 63], 'es')).toEqual(['Gato', 'Perro', 'Sillón']);
  });

  it('refuses an index outside 0..63', () => {
    for (const index of [-1, 64, 1.5, Number.NaN]) {
      expect(() => sasSymbol(index)).toThrow(RangeError);
      expect(() => sasWord(index, 'es')).toThrow(RangeError);
    }
  });
});
