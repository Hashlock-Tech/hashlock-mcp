/**
 * MCP tool wrapper for the acceptComputeCapacityListing GraphQL mutation.
 * Records a buyer's commitment to a LISTED compute-capacity batch and
 * returns operator-actionable instructions for the on-chain
 * ComputeSettlement.buy(...) call the buyer must execute next.
 *
 * PR2.2 of the hashlock-compute integration. Mirrors create_compute_capacity_listing
 * shape; uses the same structured-error-envelope convention via toErrorEnvelope.
 *
 * Requires the calling account to have `compute_trading` enabled in
 * feature_flag_account (PR2.0a).
 */

import { z } from 'zod';
import { callGraphQL } from '../../lib/graphql-client.js';
import { okContent, type ToolContent } from '../../lib/result.js';
import { toErrorEnvelope } from '../../lib/errors.js';
import { chainName } from '../../lib/chain-name.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_HEX = /^0x[a-fA-F0-9]{130}$/;
const DECIMAL_STRING = /^[0-9]+$/;

/**
 * Raw Zod shape — exported for `server.tool()` registration in index.ts.
 * `server.tool()` accepts a ZodRawShape (plain object of Zod fields),
 * NOT a ZodEffects. All validation here is per-field, no cross-field
 * refinements needed for accept.
 */
export const acceptComputeCapacityListingShape = {
  tokenId: z
    .string()
    .regex(DECIMAL_STRING, 'tokenId must be a decimal string')
    .min(1)
    .max(80)
    .describe('On-chain tokenId of the listed compute-capacity batch to purchase'),
  buyerAddress: z
    .string()
    .regex(EVM_ADDRESS, 'buyerAddress must be 0x + 40 hex chars')
    .describe('0x-prefixed EVM address of the buyer (your wallet address)'),
  buyerSignature: z
    .string()
    .regex(SIGNATURE_HEX, 'buyerSignature must be 65-byte hex (0x + 130 chars)')
    .describe('65-byte EVM signature over the listing params (0x + 130 hex chars); verified on-chain by ComputeSettlement.buy(...)'),
};

const acceptComputeCapacityListingSchema = z.object(acceptComputeCapacityListingShape).strict();

type AcceptComputeCapacityListingInput = z.infer<typeof acceptComputeCapacityListingSchema>;

// ─── GraphQL mutation document ────────────────────────────────────────────────

const ACCEPT_COMPUTE_CAPACITY_LISTING_MUTATION = /* GraphQL */ `
  mutation AcceptComputeCapacityListing($input: AcceptComputeCapacityListingInput!) {
    acceptComputeCapacityListing(input: $input) {
      trade { id }
      attestationLeg {
        tokenId
        contractAddress
        chainId
        state
        buyerSigner
      }
      buyInstruction
    }
  }
`;

// ─── Tool context ─────────────────────────────────────────────────────────────

interface ToolContext {
  /** Bearer token forwarded from the MCP client's HASHLOCK_ACCESS_TOKEN */
  authToken: string;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const acceptComputeCapacityListingTool = {
  name: 'accept_compute_capacity_listing' as const,
  description: [
    'Accept (purchase commitment) a LISTED compute-capacity batch on Hashlock Markets.',
    '',
    'Use this AFTER a provider has minted + listed capacity via ComputeSettlement on-chain.',
    'You provide your EVM address and a signature over the listing params; on-chain',
    'ComputeSettlement.buy(...) verifies the signature, not this MCP tool.',
    '',
    'Required: account must have `compute_trading` feature flag enabled.',
    '',
    'Returns: trade + attestationLeg with buyer_signer filled, plus a buyInstruction',
    'telling you how to call ComputeSettlement.buy(...) on-chain from your wallet.',
  ].join('\n'),
  handler: async (args: unknown, ctx: ToolContext): Promise<ToolContent> => {
    // 1. Validate input via Zod.
    let validated: AcceptComputeCapacityListingInput;
    try {
      validated = acceptComputeCapacityListingSchema.parse(args);
    } catch (err) {
      // Zod errors contain 'invalid'/'validation' text → classifies as VALIDATION_ERROR.
      return toErrorEnvelope(
        new Error(`Invalid input: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    // 2. POST the mutation.
    let result: {
      data?: {
        acceptComputeCapacityListing?: {
          trade: { id: string };
          attestationLeg: {
            tokenId: string;
            contractAddress: string;
            chainId: string;
            state: string;
            buyerSigner: string;
          } | null;
          buyInstruction: string;
        };
      };
      errors?: Array<{ message?: string }>;
    };
    try {
      result = await callGraphQL({
        auth: ctx.authToken,
        query: ACCEPT_COMPUTE_CAPACITY_LISTING_MUTATION,
        variables: { input: validated },
      });
    } catch (err) {
      // Network / fetch failures — pass through so classifyError applies its
      // retryability heuristics (UPSTREAM_RPC_ERROR for fetch failures, etc.).
      return toErrorEnvelope(err);
    }

    // 3. Surface GraphQL errors as structured envelope (Apollo silent-swallow guard).
    if (result.errors?.length) {
      return toErrorEnvelope(
        new Error(
          result.errors[0]?.message ?? 'acceptComputeCapacityListing failed (no message)',
        ),
      );
    }

    const payload = result.data?.acceptComputeCapacityListing;
    if (!payload?.attestationLeg) {
      return toErrorEnvelope(
        new Error('acceptComputeCapacityListing returned no attestationLeg'),
      );
    }

    const leg = payload.attestationLeg;
    return okContent({
      tradeId: payload.trade.id,
      tokenId: leg.tokenId,
      contractAddress: leg.contractAddress,
      chainId: leg.chainId,
      chain: chainName(leg.chainId),
      state: leg.state,
      buyerSigner: leg.buyerSigner,
      buyInstruction: payload.buyInstruction,
    });
  },
};
