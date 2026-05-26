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

/** Parse the structured error envelope from a tool response content[0].text */
function parseErrorEnvelope(text: string): {
  error: { code: string; message: string; is_retryable: boolean; recovery_hint: string };
} {
  return JSON.parse(text) as {
    error: { code: string; message: string; is_retryable: boolean; recovery_hint: string };
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('create_compute_capacity_listing MCP tool (PR2.1b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Case 1: Tool name contract
  it('declares the expected tool name', () => {
    expect(createComputeCapacityListingTool.name).toBe('create_compute_capacity_listing');
  });

  // Case 2: Zod validation rejects invalid input — structured error envelope
  it('rejects invalid input via Zod (regionCode wrong byte width)', async () => {
    // '0xshort' is not 8-byte hex (needs exactly 16 hex chars after 0x)
    const bad = { ...VALID, regionCode: '0xshort' };
    const res = await createComputeCapacityListingTool.handler(bad, ctx);

    // callGraphQL must NOT have been called — validation fires first
    expect(vi.mocked(callGraphQL)).not.toHaveBeenCalled();

    const text = (res.content[0] as { text: string }).text;
    const envelope = parseErrorEnvelope(text);
    expect(envelope.error.code).toBe('VALIDATION_ERROR');
    expect(envelope.error.is_retryable).toBe(false);
    expect(envelope.error.message).toMatch(/[Ii]nvalid/);
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

    // No error field — happy path returns plain data
    const text = (res.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('error');
    expect(text).toContain('"tokenId": "7777"');
    expect(text).toContain('mintInstruction');
    expect(text).toContain('"tradeId": "trade-1"');
    // Chain name lookup
    expect(text).toContain('Sepolia');
  });

  // Case 4: GraphQL errors[] surfaced as structured error envelope
  it('surfaces GraphQL errors[0].message as a structured error envelope', async () => {
    vi.mocked(callGraphQL).mockResolvedValueOnce({
      errors: [{ message: 'Compute-capacity trading is not enabled for this account.' }],
    });

    const res = await createComputeCapacityListingTool.handler(VALID, ctx);

    const text = (res.content[0] as { text: string }).text;
    const envelope = parseErrorEnvelope(text);
    expect(envelope.error.message).toContain('not enabled');
    expect(envelope.error.is_retryable).toBe(false);
    expect(typeof envelope.error.code).toBe('string');
    expect(typeof envelope.error.recovery_hint).toBe('string');
  });

  // Case 5: Network failure (rejected promise) → structured error envelope, no throw
  it('surfaces network failure as a structured error envelope (no throw)', async () => {
    vi.mocked(callGraphQL).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // Must not throw — always resolves with structured error content
    const res = await createComputeCapacityListingTool.handler(VALID, ctx);

    const text = (res.content[0] as { text: string }).text;
    const envelope = parseErrorEnvelope(text);
    expect(envelope.error.message).toContain('ECONNREFUSED');
    expect(typeof envelope.error.code).toBe('string');
    expect(typeof envelope.error.is_retryable).toBe('boolean');
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

    const text = (res.content[0] as { text: string }).text;
    const envelope = parseErrorEnvelope(text);
    expect(envelope.error.code).toBe('VALIDATION_ERROR');
    expect(envelope.error.is_retryable).toBe(false);
  });
});
