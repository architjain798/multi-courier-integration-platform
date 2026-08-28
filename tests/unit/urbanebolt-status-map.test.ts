import { describe, expect, it } from 'vitest';
import { ShipmentStatus } from '../../src/components/couriers/index.js';
import {
  isMappedStatus,
  parseUrbaneBoltTimestamp,
  toShipmentStatus,
} from '../../src/integrations/urbanebolt/urbanebolt.status-map.js';

describe('toShipmentStatus', () => {
  it('maps the two codes confirmed against the live API', () => {
    expect(toShipmentStatus('MAN')).toBe(ShipmentStatus.CREATED);
    expect(toShipmentStatus('CAN')).toBe(ShipmentStatus.CANCELLED);
  });

  it('is case and whitespace insensitive', () => {
    expect(toShipmentStatus(' man ')).toBe(ShipmentStatus.CREATED);
  });

  it('falls back to UNKNOWN instead of throwing on a code we have never seen', () => {
    expect(toShipmentStatus('ZZZ')).toBe(ShipmentStatus.UNKNOWN);
    expect(toShipmentStatus('')).toBe(ShipmentStatus.UNKNOWN);
    expect(isMappedStatus('ZZZ')).toBe(false);
  });
});

describe('parseUrbaneBoltTimestamp', () => {
  it('reads the timestamp as IST regardless of the server timezone', () => {
    const parsed = parseUrbaneBoltTimestamp('27 Aug 2026, 17:34');

    expect(parsed?.toISOString()).toBe('2026-08-27T12:04:00.000Z');
  });

  it('handles a date with no time component', () => {
    expect(parseUrbaneBoltTimestamp('02 Oct 2024')?.toISOString()).toBe(
      '2024-10-01T18:30:00.000Z',
    );
  });

  it('returns null rather than an Invalid Date for junk', () => {
    expect(parseUrbaneBoltTimestamp('not a date')).toBeNull();
    expect(parseUrbaneBoltTimestamp('')).toBeNull();
    expect(parseUrbaneBoltTimestamp('2026-08-27T17:34:00Z')).toBeNull();
  });
});
