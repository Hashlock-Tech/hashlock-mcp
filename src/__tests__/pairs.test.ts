import { describe, it, expect } from 'vitest';
import { SUPPORTED_PAIRS, SUPPORTED_PAIRS_LINE } from '../lib/pairs.js';

describe('SUPPORTED_PAIRS', () => {
  it('contains every chain-qualified pair the create_rfq description pins', () => {
    for (const p of ['ETH/sepolia','ETH/ethereum','BTC/bitcoin-signet','BTC/bitcoin','USDC/sepolia','USDC/ethereum','USDT/ethereum','WBTC/ethereum','WETH/ethereum','SUI/sui','SUI/sui-testnet']) {
      expect(SUPPORTED_PAIRS).toContain(p);
    }
  });
  it('exposes a comma-joined line for prose embedding', () => {
    expect(SUPPORTED_PAIRS_LINE).toBe(SUPPORTED_PAIRS.join(', ') + '.');
  });
});
