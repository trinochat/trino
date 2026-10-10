/**
 * Colour maths for the design tokens: #RRGGBB parsing, WCAG 2.x contrast and
 * hue, plus what the accessibility layers are measured with: how a colour
 * looks under a colour vision deficiency, and how far apart two colours look
 * (CIEDE2000).
 */

type Rgb = readonly [red: number, green: number, blue: number];

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** Channels 0–255 of a `#RRGGBB` colour, in any case. Throws on anything else. */
function parseHex(hex: string): Rgb {
  const match = HEX_COLOR.exec(hex);
  if (!match) throw new Error(`Expected a #RRGGBB colour, got ${JSON.stringify(hex)}`);
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

/**
 * WCAG 2.x relative luminance, 0 (black) to 1 (white). Uses the sRGB threshold
 * 0.04045; the 0.03928 quoted by WCAG gives the same result for 8-bit channels.
 */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHex(hex).map(linearize);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function linearize(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x contrast ratio: 1 for the same colour, 21 for black on white. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Hue in degrees (0–360) and chroma (0 for greys, 1 for pure colours). */
export function hueAndChroma(hex: string): { hue: number; chroma: number } {
  const [red, green, blue] = parseHex(hex).map(channel => channel / 255);
  const max = Math.max(red, green, blue);
  const chroma = max - Math.min(red, green, blue);
  if (chroma === 0) return { hue: 0, chroma: 0 };
  const sector =
    max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  return { hue: (sector * 60 + 360) % 360, chroma };
}

/** The three dichromacies the safe colours are checked against. */
export const DEFICIENCIES = ['protan', 'deutan', 'tritan'] as const;
export type Deficiency = (typeof DEFICIENCIES)[number];

/** CIELAB under D65: lightness 0–100, then the green–red and blue–yellow axes. */
export type Lab = readonly [lightness: number, a: number, b: number];

type Matrix = readonly [Rgb, Rgb, Rgb];

/**
 * Viénot, Brettel and Mollon (1999) for protanopia and deuteranopia, on linear
 * RGB. The matrices are libDaltonLens's (public domain), which the
 * independent Python check of the specification also uses.
 */
const VIENOT: Readonly<Record<'protan' | 'deutan', Matrix>> = {
  protan: [
    [0.11238, 0.88762, 0],
    [0.11238, 0.88762, 0],
    [0.00401, -0.00401, 1],
  ],
  deutan: [
    [0.29275, 0.70725, 0],
    [0.29275, 0.70725, 0],
    [-0.02234, 0.02234, 1],
  ],
};

/**
 * Brettel, Viénot and Mollon (1997) for tritanopia: two half-planes, chosen by
 * the side of the separation plane the colour falls on (libDaltonLens).
 */
const BRETTEL_TRITAN: Readonly<{ separation: Rgb; first: Matrix; second: Matrix }> = {
  separation: [0.03901, -0.02788, -0.01113],
  first: [
    [1.01277, 0.13548, -0.14826],
    [-0.01243, 0.86812, 0.14431],
    [0.07589, 0.805, 0.11911],
  ],
  second: [
    [0.93678, 0.18979, -0.12657],
    [0.06154, 0.81526, 0.1232],
    [-0.37562, 1.12767, 0.24796],
  ],
};

const dot = (a: Rgb, b: Rgb) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function multiply([first, second, third]: Matrix, vector: Rgb): Rgb {
  return [dot(first, vector), dot(second, vector), dot(third, vector)];
}

function clip([red, green, blue]: Rgb): Rgb {
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  return [unit(red), unit(green), unit(blue)];
}

/** Linear RGB, 0–1 per channel. */
function linearRgb(hex: string): Rgb {
  const [red, green, blue] = parseHex(hex);
  return [linearize(red), linearize(green), linearize(blue)];
}

/** Linear RGB as a dichromat sees it, clipped to the gamut. */
function simulateLinear(rgb: Rgb, deficiency: Deficiency): Rgb {
  if (deficiency !== 'tritan') return clip(multiply(VIENOT[deficiency], rgb));
  const { separation, first, second } = BRETTEL_TRITAN;
  return clip(multiply(dot(separation, rgb) >= 0 ? first : second, rgb));
}

function delinearize(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** `#RRGGBB` in capitals, from linear RGB. */
function toHex(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.round(delinearize(value) * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  return `#${rgb.map(channel).join('')}`;
}

/** How a `#RRGGBB` colour looks to a person with the deficiency, as `#RRGGBB`. */
export function simulateCvd(hex: string, deficiency: Deficiency): string {
  return toHex(simulateLinear(linearRgb(hex), deficiency));
}

/**
 * The colour in CIELAB (D65), as a person with the deficiency sees it when
 * one is given. The simulation stays unrounded: rounding it to 8 bits first
 * moves small distances by a tenth or more.
 */
export function toLab(hex: string, deficiency?: Deficiency): Lab {
  const linear = linearRgb(hex);
  const [red, green, blue] = deficiency ? simulateLinear(linear, deficiency) : linear;
  const x = 0.4124564 * red + 0.3575761 * green + 0.1804375 * blue;
  const y = 0.2126729 * red + 0.7151522 * green + 0.072175 * blue;
  const z = 0.0193339 * red + 0.119192 * green + 0.9503041 * blue;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x / 0.95047), f(y), f(z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const toRadians = (angle: number) => (angle * Math.PI) / 180;

/** The hue angle of a CIELAB colour in degrees, 0–360 (0 for a grey). */
function hueAngle(a: number, b: number): number {
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

/**
 * CIEDE2000 colour difference (Sharma, Wu and Dalal 2005): about 1 is the
 * smallest difference people see, and the safe colours keep 10 or more.
 */
export function deltaE2000(first: Lab, second: Lab): number {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  const deltaL = l2 - l1;
  const deltaC = c2p - c1p;
  let deltaHue = 0;
  if (c1p * c2p !== 0) {
    deltaHue = h2p - h1p;
    if (deltaHue > 180) deltaHue -= 360;
    else if (deltaHue < -180) deltaHue += 360;
  }
  const deltaH = 2 * Math.sqrt(c1p * c2p) * Math.sin(toRadians(deltaHue / 2));

  const meanL = (l1 + l2) / 2;
  const meanC = (c1p + c2p) / 2;
  let meanHue = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) meanHue = (h1p + h2p) / 2;
    else meanHue = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos(toRadians(meanHue - 30)) +
    0.24 * Math.cos(toRadians(2 * meanHue)) +
    0.32 * Math.cos(toRadians(3 * meanHue + 6)) -
    0.2 * Math.cos(toRadians(4 * meanHue - 63));
  const rotation = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;
  const rt = -Math.sin(toRadians(2 * rotation)) * rc;

  const lightness = deltaL / sl;
  const chroma = deltaC / sc;
  const hue = deltaH / sh;
  return Math.sqrt(lightness ** 2 + chroma ** 2 + hue ** 2 + rt * chroma * hue);
}

/** CIEDE2000 between two `#RRGGBB` colours, as seen with the deficiency when one is given. */
export function colorDistance(a: string, b: string, deficiency?: Deficiency): number {
  return deltaE2000(toLab(a, deficiency), toLab(b, deficiency));
}
