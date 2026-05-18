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
