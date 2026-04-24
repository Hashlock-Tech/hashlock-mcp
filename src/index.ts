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
  'Create and fund a Hash Time-Locked Contract (HTLC) for atomic OTC settlement. Records an on-chain ETH or ERC-20 lock transaction. The user must have already sent the lock tx on-chain. Returns trade ID and status.',
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
  'Claim an HTLC by revealing the preimage. Records the on-chain claim transaction. The counterparty uses the revealed preimage to claim the other side of the atomic swap.',
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
  'Refund an HTLC after the timelock has expired. Records the on-chain refund transaction. Only the original sender can refund, and only after the timelock deadline.',
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
  'Get the current HTLC status for a trade, including both initiator and counterparty HTLCs. Shows contract addresses, lock amounts, timelocks, and settlement status.',
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
  'Create a Request for Quote (RFQ) to buy or sell crypto OTC. Broadcasts to market makers who respond with prices. Supported tokens: ETH, BTC, USDT, USDC, WBTC, WETH.',
  {
    baseToken: z.string().describe('Base asset symbol (e.g., ETH, BTC, WBTC)'),
    quoteToken: z.string().describe('Quote asset symbol (e.g., USDT, USDC)'),
    side: z.enum(['BUY', 'SELL']).describe('BUY to purchase base token, SELL to sell base token'),
    amount: z.string().describe('Amount of base token (e.g., "1.5" for 1.5 ETH)'),
    expiresIn: z.number().optional().describe('RFQ expiration in seconds (default: server-configured)'),
    isBlind: z.boolean().optional().describe('Hide counterparty identity (blind auction mode)'),
  },
  async ({ baseToken, quoteToken, side, amount, expiresIn, isBlind }) => {
    const result = await hl.createRFQ({ baseToken, quoteToken, side, amount, expiresIn, isBlind });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── respond_rfq ─────────────────────────────────────────────

server.tool(
  'respond_rfq',
  'Submit a price quote in response to an open RFQ. Market makers use this to offer their price. If the RFQ creator accepts your quote, a trade is automatically created.',
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
