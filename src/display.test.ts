import { describe, expect, it } from 'vitest';
import { avatarContent, lineLabel } from './index';

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
