import { describe, expect, it } from 'vitest';
import { presentFailure } from '../../src/components/orders/domain/order.presenter.js';

describe('presentFailure', () => {
  it('replaces the stored courier wording with our own', () => {
    const failure = presentFailure(
      'PINCODE_NOT_SERVICEABLE',
      'Consignee Pincode 999999 is not serviceable',
    );

    expect(failure?.message).toBe('The delivery pincode is not serviceable by this courier');
    expect(JSON.stringify(failure)).not.toContain('999999');
  });

  it('passes our own message through for a failure the courier never saw', () => {
    const failure = presentFailure('VALIDATION_ERROR', 'order_id is required');

    expect(failure).toEqual({ code: 'VALIDATION_ERROR', message: 'order_id is required' });
  });

  it('reports nothing when the order has not failed', () => {
    expect(presentFailure(null, null)).toBeNull();
  });
});
