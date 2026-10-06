import { describe, expect, it } from 'vitest';
import type { Swap } from '../client.js';
import { tronLegKey } from '../settlement.js';

const swap = (s: Partial<Swap>) => ({ aChain: 'bitcoin', bChain: 'tron', onchainSwapId: null, aOnchainSwapId: null, bOnchainSwapId: null, ...s }) as Swap;

describe('tronLegKey', () => {
  it('uses the leg’s own key first', () => {
    expect(tronLegKey(swap({ bOnchainSwapId: '0xb', onchainSwapId: '0xshared' }), 'b')).toBe('0xb');
  });
  it('falls back to the shared key only for the sole TRON leg', () => {
    expect(tronLegKey(swap({ onchainSwapId: '0xshared' }), 'b')).toBe('0xshared');
    expect(() => tronLegKey(swap({ aChain: 'tron', onchainSwapId: '0xshared' }), 'a')).toThrow();
  });
  it('refuses a leg with no recorded key', () => {
    expect(() => tronLegKey(swap({}), 'b')).toThrow();
  });
});
