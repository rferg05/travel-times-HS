import { describe, expect, it } from 'vitest';
import { avatarContent, lineLabel, planLayout } from './index';

describe('member disc', () => {
  it('draws Family icons stored as lucide names', () => {
    expect(avatarContent('lucide:crown', 'Ryan')).toEqual({ icon: 'crown' });
    expect(avatarContent('lucide:heart', 'Audra')).toEqual({ icon: 'heart' });
  });
  it('shows a typed emoji as itself', () => {
    expect(avatarContent('🚲', 'Ryan')).toEqual({ text: '🚲' });
  });
  it('falls back to the initial, never the stored name', () => {
    expect(avatarContent('lucide:not-a-member-icon', 'Ryan')).toEqual({ text: 'R' });
    expect(avatarContent('custom:abc123def456', 'audra smith')).toEqual({ text: 'A' });
    expect(avatarContent('fa:solid:star', 'Ryan')).toEqual({ text: 'R' });
    expect(avatarContent(undefined, 'Ryan')).toEqual({ text: 'R' });
  });
});

describe('line chips', () => {
  it('drop the agency and "Line" from rail names', () => {
    expect(lineLabel({ name: 'CTA Blue Line', vehicle: 'SUBWAY' })).toBe('Blue');
    expect(lineLabel({ name: '56', vehicle: 'BUS' })).toBe('56');
    expect(lineLabel({ name: 'Metra UP-N Line', vehicle: 'HEAVY_RAIL' })).toBe('UP-N');
  });
});

describe('card layout', () => {
  it('puts cards side by side in a wide, short module', () => {
    // The landscape strip from the screenshot: two cards of 5 tiles.
    expect(planLayout(1700, 275, 2, 5)).toEqual({ columns: 2, tilesPerRow: 5 });
  });
  it('stacks cards in a tall module and wraps tiles to fit', () => {
    expect(planLayout(940, 1030, 2, 5).columns).toBe(1);
    const busy = planLayout(893, 676, 5, 5, { sections: 2 });
    expect(busy.columns * busy.tilesPerRow).toBeLessThanOrEqual(10);
  });
  it('keeps a set number of columns, and never more than cards', () => {
    expect(planLayout(1700, 275, 2, 5, { columns: 1 }).columns).toBe(1);
    expect(planLayout(3000, 200, 2, 4).columns).toBeLessThanOrEqual(2);
    expect(planLayout(1000, 500, 1, 4).columns).toBe(1);
  });
});
