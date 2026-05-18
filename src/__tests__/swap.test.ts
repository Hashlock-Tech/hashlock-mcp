import { describe, it, expect } from 'vitest';
import { compareDecimal, limitSatisfied } from '../lib/swap.js';

describe('compareDecimal (string decimals, no float drift)', () => {
  it('orders integers and fractions without float error', () => {
    expect(compareDecimal('100.2', '100.19')).toBe(1);
    expect(compareDecimal('100.19', '100.2')).toBe(-1);
    expect(compareDecimal('3450.00', '3450')).toBe(0);
    expect(compareDecimal('0.30000000000000004', '0.3')).toBe(1);
    expect(compareDecimal('1000000000000000000', '999999999999999999')).toBe(1);
    expect(compareDecimal('007.50', '7.5')).toBe(0);
  });
});

describe('limitSatisfied (directional — SELL floor, BUY ceiling)', () => {
  it('SELL: accept iff best >= limit (limit is a floor)', () => {
    expect(limitSatisfied('3500', '3400', 'SELL')).toBe(true);
    expect(limitSatisfied('3400', '3400', 'SELL')).toBe(true);
    expect(limitSatisfied('3399.99', '3400', 'SELL')).toBe(false);
  });
  it('BUY: accept iff best <= limit (limit is a ceiling)', () => {
    expect(limitSatisfied('3400', '3500', 'BUY')).toBe(true);
    expect(limitSatisfied('3500', '3500', 'BUY')).toBe(true);
    expect(limitSatisfied('3500.01', '3500', 'BUY')).toBe(false);
  });
});

import { selectBestBid } from '../lib/swap.js';

const q = (over: Partial<import('../lib/swap.js').SwapQuote>): import('../lib/swap.js').SwapQuote => ({
  id: 'q', rfqId: 'r', marketMakerId: 'mm', price: '100', amount: '10',
  status: 'PENDING', ...over,
});

describe('selectBestBid', () => {
  it('SELL picks the HIGHEST price among eligible', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '3400' }), q({ id: 'b', price: '3500' }), q({ id: 'c', price: '3450' })],
      'SELL', '10');
    expect(best?.id).toBe('b');
  });
  it('BUY picks the LOWEST price among eligible', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '3400' }), q({ id: 'b', price: '3500' }), q({ id: 'c', price: '3350' })],
      'BUY', '10');
    expect(best?.id).toBe('c');
  });
  it('excludes non-PENDING quotes', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '9999', status: 'EXPIRED' }), q({ id: 'b', price: '3400', status: 'PENDING' })],
      'SELL', '10');
    expect(best?.id).toBe('b');
  });
  it('excludes quotes that do not cover the requested amount (full-fill v1)', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '9999', amount: '5' }), q({ id: 'b', price: '3400', amount: '10' })],
      'SELL', '10');
    expect(best?.id).toBe('b');
  });
  it('accepts a quote whose amount exceeds the request', () => {
    const best = selectBestBid([q({ id: 'a', price: '3400', amount: '50' })], 'SELL', '10');
    expect(best?.id).toBe('a');
  });
  it('returns null when no eligible quote', () => {
    expect(selectBestBid([], 'SELL', '10')).toBeNull();
    expect(selectBestBid([q({ status: 'REJECTED' })], 'SELL', '10')).toBeNull();
    expect(selectBestBid([q({ amount: '1' })], 'SELL', '10')).toBeNull();
  });
});
