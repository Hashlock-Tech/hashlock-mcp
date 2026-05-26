/**
 * MCP tool: create_compute_capacity_listing
 *
 * Wraps the `createComputeCapacityRfq` GraphQL mutation so MCP-capable
 * clients (AI agents, Claude Desktop, Cursor, etc.) can list compute-
 * capacity batches on Hashlock Markets.
 *
 * PR2.1b of the hashlock-compute integration. Providers mint externally
 * from their own EVM wallet — the platform reconciles via the deterministic
 * tokenId once the chain-watcher observes the TokenMinted event.
 *
 * Requires the calling account to have `compute_trading` enabled in
 * `feature_flag_account` (PR2.0a). The GraphQL backend returns an
 * actionable error if the flag is off.
 *
 * Validation mirrors `createComputeCapacityRfqSchema` from @otc/shared
 * (backend/shared/src/validation/compute-schemas.ts) — kept in sync
 * manually. The Zod schema here is intentionally a copy so the public
 * package stays dependency-free of the internal monorepo.
 */

import { z } from 'zod';
import { callGraphQL } from '../../lib/graphql-client.js';

// ─── Input schema (mirrors @otc/shared createComputeCapacityRfqSchema) ────────

const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES8 = /^0x[0-9a-fA-F]{16}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_STRING = /^[1-9][0-9]*$/; // positive decimal, no leading zero, no sign
const UNIX_SECONDS_STRING = /^[1-9][0-9]{9,}$/; // 10+ digit positive (post-2001)

/**
 * Raw Zod shape — exported for `server.tool()` registration in index.ts.
 * `server.tool()` (from @modelcontextprotocol/sdk) accepts a ZodRawShape
 * (plain object of Zod fields), NOT a ZodEffects (refined schema). The
 * cross-field refinements (periodEnd > periodStart, monitorThreshold ≤
 * monitorSigners.length) are enforced by the full schema inside `handler`.
 */
export const createComputeCapacityRfqShape = {
  chainId: z.literal(11155111).describe('EVM chain ID — currently Sepolia (11155111) only'),
  skuHash: z.string().regex(HEX_BYTES32, '32-byte hex required').describe('32-byte hex hash identifying the compute SKU'),
  regionCode: z.string().regex(HEX_BYTES8, '8-byte hex required').describe('8-byte hex region code for the data-centre location'),
  periodStart: z.string().regex(UNIX_SECONDS_STRING, 'unix-seconds string required').describe('Capacity window start as a unix-seconds string (10+ digits)'),
  periodEnd: z.string().regex(UNIX_SECONDS_STRING, 'unix-seconds string required').describe('Capacity window end (must be > periodStart)'),
  disputeWindow: z.number().int().positive().max(0xffffffff).describe('Dispute resolution window in seconds (positive integer, max 2^32-1)'),
  termsHash: z.string().regex(HEX_BYTES32, '32-byte hex required').describe('32-byte hex hash of the off-chain SLA/terms document'),
  unitNotional: z.string().regex(DECIMAL_STRING, 'positive decimal string required').describe('Notional value per compute unit as a positive decimal string (no leading zero, no sign)'),
  pAcceptBps: z.number().int().min(0).max(10000).describe('Acceptance probability in basis points (0–10000)'),
  providerSigner: z.string().regex(EVM_ADDRESS, 'EVM address required').describe('0x-prefixed EVM address of the compute provider signer'),
  monitorSigners: z.array(z.string().regex(EVM_ADDRESS)).min(1).max(255).describe('1–255 EVM addresses of the monitor/oracle signers'),
  monitorThreshold: z.number().int().min(1).max(255).describe('Minimum monitor signatures required (must be ≤ monitorSigners.length)'),
  quoteToken: z.literal('USDC').describe('Settlement token — currently only "USDC" is supported'),
};

/**
 * Full schema with cross-field refinements. Used inside `handler` for
 * complete validation including periodEnd > periodStart and
 * monitorThreshold ≤ monitorSigners.length.
 */
const createComputeCapacityRfqSchema = z
  .object(createComputeCapacityRfqShape)
  .refine((d) => BigInt(d.periodEnd) > BigInt(d.periodStart), {
    message: 'periodEnd must be > periodStart',
    path: ['periodEnd'],
  })
  .refine((d) => d.monitorThreshold <= d.monitorSigners.length, {
    message: 'monitorThreshold must be ≤ monitorSigners.length',
    path: ['monitorThreshold'],
  });

type CreateComputeCapacityRfqInput = z.infer<typeof createComputeCapacityRfqSchema>;

// ─── GraphQL mutation document ────────────────────────────────────────────────

const CREATE_COMPUTE_CAPACITY_RFQ_MUTATION = /* GraphQL */ `
  mutation CreateComputeCapacityRfq($input: CreateComputeCapacityRfqInput!) {
    createComputeCapacityRfq(input: $input) {
      trade { id }
      attestationLeg {
        tokenId
        contractAddress
        chainId
        state
      }
    }
  }
`;

// ─── MCP tool response helpers ────────────────────────────────────────────────

interface McpContent {
  type: 'text';
  text: string;
}

interface McpToolResponse {
  isError?: boolean;
  content: McpContent[];
}

function mcpError(message: string): McpToolResponse {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// ─── Tool definition ──────────────────────────────────────────────────────────

interface ToolContext {
  /** Bearer token forwarded from the MCP client's HASHLOCK_ACCESS_TOKEN */
  authToken: string;
}

export const createComputeCapacityListingTool = {
  name: 'create_compute_capacity_listing' as const,
  description: [
    'List a new compute-capacity batch for sale on Hashlock Markets.',
    '',
    'Records the listing intent on the platform (creates an optimistic attestation_leg row). ',
    'The provider must separately execute the on-chain ComputeSettlement.mint(...) transaction ',
    'from their own EVM wallet — use the returned tokenId, contractAddress and chainId to ',
    'construct the call. The platform reconciles once it observes the TokenMinted event with ',
    'the matching deterministic tokenId.',
    '',
    'USE WHEN: acting as a compute provider and wanting to list a compute-capacity batch for',
    'purchase by buyers on Hashlock Markets.',
    'DO NOT USE WHEN: acting as a buyer — use create_rfq for the buy side.',
    '',
    'PREREQUISITE: The calling account must have the `compute_trading` feature flag enabled.',
    'If not, the backend returns an actionable error message — do NOT retry.',
  ].join(''),
  inputSchema: createComputeCapacityRfqSchema,
  handler: async (args: unknown, ctx: ToolContext): Promise<McpToolResponse> => {
    // 1. Validate input via Zod.
    let validated: CreateComputeCapacityRfqInput;
    try {
      validated = createComputeCapacityRfqSchema.parse(args);
    } catch (err) {
      return mcpError(
        `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. POST the mutation.
    let result: {
      data?: {
        createComputeCapacityRfq?: {
          trade: { id: string };
          attestationLeg: {
            tokenId: string;
            contractAddress: string;
            chainId: string;
            state: string;
          } | null;
        };
      };
      errors?: Array<{ message?: string }>;
    };
    try {
      result = await callGraphQL({
        auth: ctx.authToken,
        query: CREATE_COMPUTE_CAPACITY_RFQ_MUTATION,
        variables: { input: validated },
      });
    } catch (err) {
      return mcpError(
        `createComputeCapacityRfq network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3. Surface GraphQL errors as MCP errors (Apollo silent-swallow guard).
    if (result.errors?.length) {
      return mcpError(
        result.errors[0]?.message ?? 'createComputeCapacityRfq failed (no message)',
      );
    }

    const payload = result.data?.createComputeCapacityRfq;
    if (!payload?.attestationLeg) {
      return mcpError('createComputeCapacityRfq returned no attestationLeg');
    }

    const leg = payload.attestationLeg;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tradeId: payload.trade.id,
              tokenId: leg.tokenId,
              contractAddress: leg.contractAddress,
              chainId: leg.chainId,
              state: leg.state,
              mintInstruction:
                `Next: call ComputeSettlement.mint(...) on chain ${leg.chainId} ` +
                `at ${leg.contractAddress} with the exact params you submitted; ` +
                `the platform reconciles tokenId ${leg.tokenId} on-event.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
