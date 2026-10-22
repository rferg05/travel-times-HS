import { describe, expect, it } from 'vitest';
import { NEUTRAL_PALETTE, paletteFor, textOn } from './colors';

describe('rider palettes', () => {
  it('keep the Family color as the base and stay in its hue', () => {
    const p = paletteFor('#ec4899');
    expect(p.base).toBe('rgb(236, 72, 153)');
    // Surface is a dark pink, the rim a lighter one.
    const [r, g, b] = p.surface.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b - 10);
    expect(r + g + b).toBeLessThan(220);
  });

  it('pick legible text on the color', () => {
    expect(textOn([59, 130, 246])).toBe('#ffffff'); // blue
    expect(textOn([253, 224, 71])).not.toBe('#ffffff'); // yellow gets dark text
    expect(paletteFor('#fde047').onBase).not.toBe('#ffffff');
  });

  it('fall back to neutral for missing or unreadable colors', () => {
    expect(paletteFor(undefined)).toBe(NEUTRAL_PALETTE);
    expect(paletteFor('not a color')).toBe(NEUTRAL_PALETTE);
  });
});
