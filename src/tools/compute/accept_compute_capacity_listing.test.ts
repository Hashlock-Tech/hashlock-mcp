import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/graphql-client.js', () => ({
  callGraphQL: vi.fn(),
}));

import { callGraphQL } from '../../lib/graphql-client.js';
import { acceptComputeCapacityListingTool } from './accept_compute_capacity_listing.js';

const VALID = {
  tokenId: '7777',
  buyerAddress: '0xeEeEEeeeeEeeeeEeEEEEEEEEEeeeEeeeeeEEeEeE',
  buyerSignature: '0x' + '1'.repeat(130),
};
const ctx = { authToken: 'fake-bearer-token' };

function parseEnvelope(res: any) {
  const text = (res.content?.[0] as { text: string })?.text ?? '';
  try { return JSON.parse(text); } catch { return null; }
}

describe('accept_compute_capacity_listing MCP tool (PR2.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares the expected tool name', () => {
    expect(acceptComputeCapacityListingTool.name).toBe('accept_compute_capacity_listing');
  });

  it('rejects malformed buyerAddress via Zod', async () => {
    const bad = { ...VALID, buyerAddress: 'not-an-address' };
    const res = await acceptComputeCapacityListingTool.handler(bad, ctx as any);
    const env = parseEnvelope(res);
    expect(env?.error?.code).toBe('VALIDATION_ERROR');
    expect(env?.error?.is_retryable).toBe(false);
  });

  it('happy path returns buyInstruction text with chain name + tokenId', async () => {
    vi.mocked(callGraphQL).mockResolvedValueOnce({
      data: {
        acceptComputeCapacityListing: {
          trade: { id: 'trade-1' },
          attestationLeg: {
            tokenId: '7777',
            contractAddress: '0x0f3174bd87C9bD1c68783674CF866845789BAD6a',
            chainId: '11155111',
            state: 'LISTED',
            buyerSigner: VALID.buyerAddress,
          },
          buyInstruction: 'Next: call ComputeSettlement.buy(7777, 0x...) from 0xEee... on Sepolia (chainId 11155111) at 0x0f31...',
        },
      },
    });
    const res = await acceptComputeCapacityListingTool.handler(VALID, ctx as any);
    const text = (res.content?.[0] as { text: string })?.text ?? '';
    expect(text).toContain('Sepolia');
    expect(text).toContain('7777');
    expect(text).toContain('buyInstruction');
  });

  it('surfaces GraphQL CONFLICT (already accepted) as not-retryable envelope', async () => {
    vi.mocked(callGraphQL).mockResolvedValueOnce({
      errors: [{ message: 'attestation_leg already accepted or no longer LISTED' }],
    });
    const res = await acceptComputeCapacityListingTool.handler(VALID, ctx as any);
    const env = parseEnvelope(res);
    expect(env?.error?.is_retryable).toBe(false);
    expect(env?.error?.message).toContain('already accepted');
  });

  it('surfaces network failure as retryable envelope', async () => {
    vi.mocked(callGraphQL).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await acceptComputeCapacityListingTool.handler(VALID, ctx as any);
    const env = parseEnvelope(res);
    expect(env?.error).toBeDefined();
  });

  it('rejects missing buyerSignature via Zod', async () => {
    const bad = { ...VALID, buyerSignature: undefined } as any;
    const res = await acceptComputeCapacityListingTool.handler(bad, ctx as any);
    const env = parseEnvelope(res);
    expect(env?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing buyerAddress via Zod', async () => {
    const bad = { ...VALID, buyerAddress: undefined } as any;
    const res = await acceptComputeCapacityListingTool.handler(bad, ctx as any);
    const env = parseEnvelope(res);
    expect(env?.error?.code).toBe('VALIDATION_ERROR');
  });
});
