/** Canonical chain-qualified pairs. Single source of truth for the
 *  list_supported_pairs tool (and future use). The create_rfq description
 *  keeps its own prose copy intentionally — its pin tests assert that text. */
export const SUPPORTED_PAIRS = [
  'ETH/sepolia', 'ETH/ethereum',
  'BTC/bitcoin-signet', 'BTC/bitcoin',
  'USDC/sepolia', 'USDC/ethereum',
  'USDT/ethereum', 'WBTC/ethereum', 'WETH/ethereum',
  'SUI/sui', 'SUI/sui-testnet',
] as const;

export const SUPPORTED_PAIRS_LINE = SUPPORTED_PAIRS.join(', ') + '.';
