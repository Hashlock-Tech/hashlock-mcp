/**
 * TDD tests for the create_compute_capacity_listing MCP tool (PR2.1b).
 *
 * Architecture note: this package is the public npm package
 * @hashlock-tech/mcp — it does NOT import @otc/shared or any internal
 * monorepo package. The Zod schema is inlined in the tool file.
 * callGraphQL is a thin fetch wrapper in lib/graphql-client.ts; we mock
 * it here so tests never hit the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the graphql-client module BEFORE importing anything that uses it.
vi.mock('../../lib/graphql-client.js', () => ({
  callGraphQL: vi.fn(),
}));

import { callGraphQL } from '../../lib/graphql-client.js';
import { createComputeCapacityListingTool } from './create_compute_capacity_listing.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** A valid input that passes the Zod schema. Mirrors VALID in compute-schemas.test.ts */
const VALID = {
  chainId: 11155111,
  skuHash: '0x' + 'a'.repeat(64),
  // 8-byte hex = 16 hex chars after 0x
  regionCode: '0x' + 'b'.repeat(16),
  periodStart: '1800000000',
  periodEnd: '1800003600',
  disputeWindow: 3600,
  termsHash: '0x' + 'c'.repeat(64),
  unitNotional: '1000000',
  pAcceptBps: 9500,
  providerSigner: '0x' + 'd'.repeat(40),
  monitorSigners: ['0x' + 'e'.repeat(40)],
  monitorThreshold: 1,
  quoteToken: 'USDC',
} as const;

const ctx = { authToken: 'fake-bearer-token' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('create_compute_capacity_listing MCP tool (PR2.1b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Case 1: Tool name contract
  it('declares the expected tool name', () => {
    expect(createComputeCapacityListingTool.name).toBe('create_compute_capacity_listing');
  });

  // Case 2: Zod validation rejects invalid input
  it('rejects invalid input via Zod (regionCode wrong byte width)', async () => {
    // '0xshort' is not 8-byte hex (needs exactly 16 hex chars after 0x)
    const bad = { ...VALID, regionCode: '0xshort' };
    const res = await createComputeCapacityListingTool.handler(bad, ctx);
    expect(res.isError).toBe(true);
    // callGraphQL must NOT have been called — validation fires first
    expect(vi.mocked(callGraphQL)).not.toHaveBeenCalled();
  });

  // Case 3: Happy path — successful GraphQL call
  it('happy path returns mintInstruction text after a successful GraphQL call', async () => {
    vi.mocked(callGraphQL).mockResolvedValueOnce({
      data: {
        createComputeCapacityRfq: {
          trade: { id: 'trade-1' },
          attestationLeg: {
            tokenId: '7777',
            contractAddress: '0x0f3174bd87C9bD1c68783674CF866845789BAD6a',
            chainId: '11155111',
            state: 'MINTED',
          },
        },
      },
    });

    const res = await createComputeCapacityListingTool.handler(VALID, ctx);

    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('"tokenId": "7777"');
    expect(text).toContain('mintInstruction');
    expect(text).toContain('"tradeId": "trade-1"');
  });

  // Case 4: GraphQL errors[] surfaced as MCP error
  it('surfaces GraphQL errors[0].message as an MCP error', async () => {
    vi.mocked(callGraphQL).mockResolvedValueOnce({
      errors: [{ message: 'Compute-capacity trading is not enabled for this account.' }],
    });

    const res = await createComputeCapacityListingTool.handler(VALID, ctx);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('not enabled');
  });

  // Case 5: Network failure (rejected promise) → MCP error, no throw
  it('surfaces network failure as an MCP error (no throw)', async () => {
    vi.mocked(callGraphQL).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // Must not throw — always resolves with isError:true
    const res = await createComputeCapacityListingTool.handler(VALID, ctx);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('ECONNREFUSED');
  });

  // Bonus Case 6: callGraphQL receives correct Bearer token
  it('passes authToken as Bearer auth to callGraphQL', async () => {
    vi.mocked(callGraphQL).mockResolvedValueOnce({
      data: {
        createComputeCapacityRfq: {
          trade: { id: 'trade-2' },
          attestationLeg: {
            tokenId: '42',
            contractAddress: '0x' + 'f'.repeat(40),
            chainId: '11155111',
            state: 'LISTED',
          },
        },
      },
    });

    await createComputeCapacityListingTool.handler(VALID, { authToken: 'my-secret-token' });

    const call = vi.mocked(callGraphQL).mock.calls[0][0];
    expect(call.auth).toBe('my-secret-token');
    expect(call.query).toContain('createComputeCapacityRfq');
    expect(call.variables).toMatchObject({ input: expect.objectContaining({ chainId: 11155111 }) });
  });

  // Bonus Case 7: Additional Zod validation — chainId must be literal 11155111
  it('rejects chainId that is not 11155111', async () => {
    const bad = { ...VALID, chainId: 1 };
    const res = await createComputeCapacityListingTool.handler(bad, ctx);
    expect(res.isError).toBe(true);
  });
});
