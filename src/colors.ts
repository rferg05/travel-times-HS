// A card's colors, worked out from one person's Settings > Family color.
//
// Everything on a rider's card comes from that one hue, so the whole card
// reads as theirs from across the room: the color bar and initial disc in
// the color itself, a dark surface and darker tiles in the same hue, a
// lighter rim, and a light tint of it marking the fastest way. Text on the
// color picks white or near-black, whichever is more legible on it. A
// card for nobody in particular gets the same treatment in neutral gray with
// the module's blue accent.

import { parseColor, resolveColor } from './host-style';

export interface Palette {
  /** The person's own color: the bar, the initial disc, the name tag. */
  base: string;
  /** Text and icons on `base`. */
  onBase: string;
  /** The card's surface. */
  surface: string;
  /** The tiles' surface, a step darker. */
  tile: string;
  /** The card's rim. */
  rim: string;
  /** The fastest tile's outline and badge. */
  highlight: string;
  /** The fastest tile's surface. */
  highlightSurface: string;
  /** Text on `highlight`. */
  onHighlight: string;
  /** The ring around the initial disc. */
  ring: string;
}

type RGB = [number, number, number];
type HSL = [number, number, number];

function toHsl([r, g, b]: RGB): HSL {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function toRgb([h, s, l]: HSL): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const css = (rgb: RGB, alpha = 1) =>
  alpha >= 1 ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

/** WCAG relative luminance. */
function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const DARK_TEXT: RGB = [17, 24, 39];

/** White when it reaches WCAG's 3:1 for large text (everything drawn on a
 *  rider color is bold: initials, name tags, the "fastest" badge), else
 *  near-black. Strict "whichever contrasts more" would put dark text on
 *  mid-blues and pinks, which reads worse from a distance. */
export function textOn(bg: RGB): string {
  return contrast(luminance(bg), 1) >= 3 ? '#ffffff' : css(DARK_TEXT);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The palette for one color. Anything unreadable falls back to neutral. */
export function paletteFor(color: string | null | undefined): Palette {
  const resolved = color ? resolveColor(color) : null;
  const rgb = resolved ? parseColor(resolved) : null;
  if (!rgb) return NEUTRAL;
  const [h, s] = toHsl(rgb);
  const highlight = toRgb([h, clamp(s, 0.55, 0.95), 0.72]);
  return {
    base: css(rgb),
    onBase: textOn(rgb),
    surface: css(toRgb([h, clamp(s * 0.6, 0.12, 0.5), 0.17]), 0.9),
    tile: css(toRgb([h, clamp(s * 0.45, 0.1, 0.4), 0.1]), 0.92),
    rim: css(toRgb([h, clamp(s, 0.35, 0.9), 0.6])),
    highlight: css(highlight),
    highlightSurface: css(toRgb([h, clamp(s, 0.35, 0.8), 0.26]), 0.95),
    onHighlight: textOn(highlight),
    ring: css(toRgb([h, clamp(s, 0.3, 0.9), 0.9])),
  };
}

/** No rider: gray surfaces, the module's blue for "fastest". */
const NEUTRAL: Palette = {
  base: 'rgba(255, 255, 255, 0.45)',
  onBase: '#ffffff',
  surface: 'rgba(30, 33, 38, 0.88)',
  tile: 'rgba(12, 14, 17, 0.9)',
  rim: 'rgba(255, 255, 255, 0.18)',
  highlight: '#38bdf8',
  highlightSurface: 'rgba(14, 64, 92, 0.95)',
  onHighlight: '#04263a',
  ring: 'rgba(255, 255, 255, 0.85)',
};

export { NEUTRAL as NEUTRAL_PALETTE };
