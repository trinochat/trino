/** Colour maths for the design tokens: #RRGGBB parsing, WCAG 2.x contrast and hue. */

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
