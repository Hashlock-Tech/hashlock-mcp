import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HashLock } from '@hashlock-tech/sdk';

// Default to the direct api-gateway endpoint (/graphql), NOT the browser-only
// SSR proxy at /api/graphql. The SSR proxy reads the httpOnly `api-token`
// cookie and ignores the Authorization header — which is incompatible with
// the Bearer-JWT scheme this package sends via @hashlock-tech/sdk. External
// MCP clients (Claude Desktop, Cursor, Windsurf, etc.) do not set cookies,
// so they hit /api/graphql and get
// `{"errors":[{"message":"Unauthorized – missing api-token",...}]}` 401.
// /graphql (direct to api-gateway) accepts Bearer and works. Override via
// HASHLOCK_ENDPOINT if you need to point at a staging / self-hosted deploy.
const ENDPOINT = process.env.HASHLOCK_ENDPOINT || 'https://hashlock.markets/graphql';
const ACCESS_TOKEN = process.env.HASHLOCK_ACCESS_TOKEN || '';

const hl = new HashLock({
  endpoint: ENDPOINT,
  accessToken: ACCESS_TOKEN,
  retries: 2,
  timeout: 30_000,
});

const server = new McpServer({
  name: 'hashlock',
  version: '0.1.8',
});

// ─── create_htlc ─────────────────────────────────────────────

server.tool(
  'create_htlc',
  'Record an on-chain HTLC lock tx hash for atomic OTC settlement. USE WHEN: a trade is accepted and the user has just broadcast the lock transaction on-chain (EVM, Bitcoin, or Sui). DO NOT USE WHEN: trade not yet accepted, or lock tx not yet confirmed on-chain. Chain-aware via chainType param. Returns trade ID and status.',
  {
    tradeId: z.string().describe('Trade ID from an accepted trade'),
    txHash: z.string().describe('On-chain transaction hash of the HTLC lock (0x-prefixed)'),
    role: z.enum(['INITIATOR', 'COUNTERPARTY']).describe('Your role in the trade'),
    timelock: z.number().optional().describe('HTLC expiry as Unix timestamp'),
    hashlock: z.string().optional().describe('SHA-256 hashlock (0x-prefixed hex)'),
    chainType: z.string().optional().describe('Chain type: evm, bitcoin, or sui'),
    preimage: z.string().optional().describe('Secret preimage (only for initiator)'),
  },
  async ({ tradeId, txHash, role, timelock, hashlock, chainType, preimage }) => {
    const result = await hl.fundHTLC({ tradeId, txHash, role, timelock, hashlock, chainType, preimage });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── withdraw_htlc ───────────────────────────────────────────

server.tool(
  'withdraw_htlc',
  'Claim an HTLC by revealing the 32-byte preimage — atomically unlocks the other leg of the swap. USE WHEN: counterparty has locked their side and the user wants to claim. DO NOT USE WHEN: counterparty lock not confirmed yet OR timelock has expired (use refund_htlc instead). Revealing the preimage is what makes the swap atomic — once revealed, the counterparty can claim the initiator\'s side with the same preimage.',
  {
    tradeId: z.string().describe('Trade ID'),
    txHash: z.string().describe('On-chain claim transaction hash (0x-prefixed)'),
    preimage: z.string().describe('The 32-byte secret preimage (0x-prefixed hex)'),
    chainType: z.string().optional().describe('Chain type: evm, bitcoin, or sui'),
  },
  async ({ tradeId, txHash, preimage, chainType }) => {
    const result = await hl.claimHTLC({ tradeId, txHash, preimage, chainType });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── refund_htlc ─────────────────────────────────────────────

server.tool(
  'refund_htlc',
  'Refund an expired HTLC — pulls the user\'s locked funds back after timelock deadline. USE WHEN: counterparty never locked their side AND the timelock has passed. DO NOT USE WHEN: counterparty HAS locked and the swap can still complete (use withdraw_htlc). Only the original sender can refund, only post-deadline.',
  {
    tradeId: z.string().describe('Trade ID'),
    txHash: z.string().describe('On-chain refund transaction hash (0x-prefixed)'),
    chainType: z.string().optional().describe('Chain type: evm, bitcoin, or sui'),
  },
  async ({ tradeId, txHash, chainType }) => {
    const result = await hl.refundHTLC({ tradeId, txHash, chainType });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── get_htlc ────────────────────────────────────────────────

server.tool(
  'get_htlc',
  'Query live HTLC status for a trade — both initiator and counterparty legs, contract addresses, lock amounts, timelocks, preimage reveal status. USE WHEN: displaying status, deciding next action, or building audit trails. Safe to call at any time — read-only.',
  {
    tradeId: z.string().describe('Trade ID to query HTLC status for'),
  },
  async ({ tradeId }) => {
    const result = await hl.getHTLCStatus(tradeId);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── create_rfq ──────────────────────────────────────────────

server.tool(
  'create_rfq',
  'Create a Request for Quote (RFQ) for an OTC swap — broadcast to market makers for sealed-bid quotes. USE WHEN: user needs competitive quotes (not AMM curve fill) for size ≥ $10k, cross-chain swaps, privacy-sensitive orders, or expressed a "negotiate" / "best execution" / "large block" / "institutional" intent. DO NOT USE WHEN: sub-second execution is required, or pair is a long-tail memecoin with no market-maker coverage (prefer DEX aggregator). Set isBlind=true for Ghost Auction mode (hides requester identity from bidders). Supported tokens: ETH, BTC, USDT, USDC, WBTC, WETH.',
  {
    baseToken: z.string().describe('Base asset symbol (e.g., ETH, BTC, WBTC)'),
    quoteToken: z.string().describe('Quote asset symbol (e.g., USDT, USDC)'),
    side: z.enum(['BUY', 'SELL']).describe('BUY to purchase base token, SELL to sell base token'),
    amount: z.string().describe('Amount of base token (e.g., "1.5" for 1.5 ETH)'),
    expiresIn: z.number().optional().describe('RFQ expiration in seconds (default: server-configured)'),
    isBlind: z.boolean().optional().describe('Enable Ghost Auction mode — hides requester identity from bidders and losing counterparties. Param name retained for API/DB schema stability; external brand is "Ghost Auction".'),
  },
  async ({ baseToken, quoteToken, side, amount, expiresIn, isBlind }) => {
    const result = await hl.createRFQ({ baseToken, quoteToken, side, amount, expiresIn, isBlind });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── respond_rfq ─────────────────────────────────────────────

server.tool(
  'respond_rfq',
  'Submit a sealed-bid price quote to an open RFQ (market-maker side). USE WHEN: the MCP client is acting as a market maker and has decided to quote on an open RFQ. DO NOT USE WHEN: acting as an end-user buyer/seller — use create_rfq to request quotes instead. Competing quotes are sealed (no MM sees another\'s price). If the RFQ creator accepts, a trade is auto-created.',
  {
    rfqId: z.string().describe('ID of the RFQ to respond to'),
    price: z.string().describe('Price per unit of base token in quote token terms (e.g., "3450.00")'),
    amount: z.string().describe('Amount of base token to offer'),
    expiresIn: z.number().optional().describe('Quote expiration in seconds'),
  },
  async ({ rfqId, price, amount, expiresIn }) => {
    const result = await hl.submitQuote({ rfqId, price, amount, expiresIn });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Start server ────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('HashLock MCP server failed:', err);
  process.exit(1);
});
