/**
 * The focus ring of what sits inside a message bubble: links, a picture,
 * Descargar. FOCUS_RING (src/ui) draws in accentText, which vanishes on your
 * own bubble in Terminal light, where the bubble is the accent (1.0:1). This
 * ring takes the bubble's own text colour, bubbleMeInk or bubbleInInk, which
 * reads on it; forced colours give it the theme's text colour, as FOCUS_RING.
 */
export const BUBBLE_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current focus-visible:shadow-none more-contrast:focus-visible:outline-[3px] forced-colors:focus-visible:outline-[color:CanvasText]';
