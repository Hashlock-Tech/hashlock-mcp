/**
 * Human-readable name for an EVM chainId.
 *
 * Used by MCP tools when generating operator-actionable text (e.g.
 * "call ComputeSettlement.buy(...) on Sepolia") so AI agents can read
 * a chain name instead of pattern-matching a numeric id.
 *
 * Extracted in PR2.2 (2nd consumer); future compute tools add their
 * chain entries here.
 */
export function chainName(chainId: string | number): string {
  const id = String(chainId);
  if (id === '11155111') return 'Sepolia';
  if (id === '1') return 'Ethereum mainnet';
  if (id === '8453') return 'Base mainnet';
  if (id === '56') return 'BNB mainnet';
  return `chainId ${id}`;
}
