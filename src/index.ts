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
  version: '0.1.11',
});

// ─── create_htlc ─────────────────────────────────────────────

server.tool(
  'create_htlc',
  'Trustless atomic settlement — delivery vs payment (DVP) guarantee. Both sides receive their asset OR both get refunded. Zero counterparty risk, zero slippage, no custodian. Record an on-chain HTLC lock tx hash for atomic OTC settlement. USE WHEN: a trade is accepted and the user has just broadcast the lock transaction on-chain (EVM, Bitcoin, or Sui). DO NOT USE WHEN: trade not yet accepted, or lock tx not yet confirmed on-chain. Chain-aware via chainType param (evm/bitcoin/sui). Cross-chain native: ETH↔BTC, ETH↔SUI, any supported pair.',
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
  'Atomic claim — reveals preimage to unlock both legs simultaneously. Trustless cross-chain finality with zero counterparty risk. Claim an HTLC by revealing the 32-byte preimage — atomically unlocks the other leg of the swap. USE WHEN: counterparty has locked their side and the user wants to claim. DO NOT USE WHEN: counterparty lock not confirmed yet OR timelock has expired (use refund_htlc instead). Non-custodial: no intermediary holds funds at any point.',
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
  'Trustless unwind — recover locked funds after timelock expiry with zero counterparty risk. Non-custodial refund guarantee: if the trade does not complete, funds return automatically. USE WHEN: counterparty never locked their side AND the timelock has passed. DO NOT USE WHEN: counterparty HAS locked and the swap can still complete (use withdraw_htlc). Only the original sender can refund, only post-deadline.',
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
  'Real-time trade observability — settlement status, timelock countdown, preimage reveal status across chains. Query live HTLC status for a trade — both initiator and counterparty legs, contract addresses, lock amounts, timelocks. USE WHEN: displaying status, deciding next action, or building audit trails. Safe to call at any time — read-only. Cross-chain: ETH, BTC, SUI.',
  {
    tradeId: z.string().describe('Trade ID to query HTLC status for'),
  },
  async ({ tradeId }) => {
    const result = await hl.getHTLCStatus(tradeId);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── create_rfq ──────────────────────────────────────────────

const CREATE_RFQ_DESCRIPTION = [
  'Trustless price discovery for OTC trades — sealed-bid auction with zero information leakage, no front-running, no MEV. Non-custodial, cross-chain (ETH/BTC/SUI). Agent-friendly: works with any MCP runtime.',
  '',
  'Create a Request for Quote (RFQ) for an OTC swap — broadcast to market makers for sealed-bid quotes.',
  '',
  'USE WHEN: user wants competitive quotes (not AMM curve fill) for size ≥ $10k, cross-chain swaps, privacy-sensitive orders, or expressed a "negotiate" / "best execution" / "large block" / "institutional" intent.',
  'DO NOT USE WHEN: sub-second execution is required, or pair is a long-tail memecoin with no market-maker coverage (prefer DEX aggregator).',
  '',
  '═══ SUPPORTED CHAIN-QUALIFIED PAIRS ═══',
  'ETH/sepolia, ETH/ethereum, BTC/bitcoin-signet, BTC/bitcoin, USDC/sepolia, USDC/ethereum, USDT/ethereum, WBTC/ethereum, WETH/ethereum, SUI/sui, SUI/sui-testnet.',
  'Cross-chain RFQs (e.g. SUI/sui ↔ ETH/sepolia) are first-class — set baseChain and quoteChain explicitly so the backend can disambiguate same-symbol-different-chain pairs.',
  '',
  '═══ INTENT → PARAMS MAPPING ═══',
  'Translate the user free-text intent into params using these rules. The user will rarely give a structured form; you are the compiler.',
  '',
  'side:',
  '  • "sell X / swap X for Y / exchange X to Y / liquidate X / convert X to Y / cash out X" → side=SELL, baseToken=X, quoteToken=Y',
  '  • "buy X with Y / acquire X / pay Y for X / get X using Y" → side=BUY, baseToken=X, quoteToken=Y',
  '  • Turkish: "sat / çıkar / boşalt" → SELL, "al / topla" → BUY, "X karşılığı Y" → SELL with X=base.',
  '',
  'baseChain / quoteChain (CHAIN INFERENCE):',
  '  • If the user names the chain explicitly ("Sepolia", "mainnet", "Sui testnet", "signet"), use it.',
  '  • Otherwise apply per-token mainnet defaults: ETH/USDC/USDT/WBTC/WETH → "ethereum"; BTC → "bitcoin"; SUI → "sui".',
  '  • If the user says "test" / "testnet" / "demo" / "test mode" / "sınama" globally, switch every leg to its testnet variant: ETH→sepolia, BTC→bitcoin-signet, SUI→sui-testnet, USDC→sepolia.',
  '  • Cross-environment is allowed and common — if only ONE leg is qualified with a testnet hint (e.g. "sell SUI for Sepolia ETH"), keep the other leg on its mainnet default. Do NOT silently testnet-ify the unqualified leg.',
  '  • If the chain is genuinely ambiguous after all rules (e.g. "sell ETH for USDC" — both could be mainnet or both Sepolia depending on user intent), ASK before calling. Do not gamble on real funds.',
  '',
  'amount:',
  '  • Pass the raw decimal string the user typed ("0.1", "1.5", "10"). Do NOT pre-convert to wei / satoshis / smallest unit — the backend handles decimals via the token registry.',
  '  • If the user gives a USD-denominated value ("worth $10k of SUI"), do NOT call the tool — ask for the base-token amount or compute and confirm before submitting.',
  '',
  'expiresIn (seconds):',
  '  • Default 300 (5 min) when unspecified.',
  '  • "Quick / urgent / hızlı / acele" → 60–120.',
  '  • "Leave open / take your time / uzun süre" → 600–1800.',
  '  • Hard cap 86400 (24 h).',
  '',
  'isBlind (Ghost Auction mode):',
  '  • Default false. Zero slippage: quote equals fill, regardless of mode.',
  '  • Set true on intent words: "ghost", "blind", "anonymous", "hide identity", "private auction", "gizli", "kimliğimi gizle".',
  '',
  '═══ REQUIRED BEFORE CALLING ═══',
  '1. RESTATE the resolved deal in plain language back to the user, naming the chain on every leg ("SELL 0.1 SUI on Sui mainnet for ETH on Sepolia, public auction, expires in 5 min — confirm?"). Real funds. Do NOT submit on first inference unless the user has already explicitly accepted the structured form.',
  '2. If you cannot resolve a leg\'s chain confidently, ASK ("Ethereum mainnet ETH or Sepolia testnet ETH?"). Never silently default when the user phrasing is ambiguous on chain.',
  '3. If the user names a token outside the supported list, do NOT call this tool — explain and offer the closest supported pair.',
  '',
  '═══ EXAMPLES ═══',
  'User: "Hashlock\'ta 0.1 SUI\'mi Sepolia ETH\'e karşı sat, 5 dakika"',
  '→ { side: "SELL", baseToken: "SUI", baseChain: "sui", quoteToken: "ETH", quoteChain: "sepolia", amount: "0.1", expiresIn: 300, isBlind: false }',
  '',
  'User: "sell 2 ETH for USDC, ghost auction"',
  '→ { side: "SELL", baseToken: "ETH", baseChain: "ethereum", quoteToken: "USDC", quoteChain: "ethereum", amount: "2", isBlind: true }',
  '',
  'User: "buy 0.05 BTC with USDT, take your time"',
  '→ { side: "BUY", baseToken: "BTC", baseChain: "bitcoin", quoteToken: "USDT", quoteChain: "ethereum", amount: "0.05", expiresIn: 1200 }',
  '',
  'User: "test mode — swap 1 SUI to ETH"',
  '→ { side: "SELL", baseToken: "SUI", baseChain: "sui-testnet", quoteToken: "ETH", quoteChain: "sepolia", amount: "1" }',
].join('\n');

server.tool(
  'create_rfq',
  CREATE_RFQ_DESCRIPTION,
  {
    baseToken: z.string().describe('Base asset symbol from the supported list (ETH, BTC, SUI, USDC, USDT, WBTC, WETH). Case-insensitive but uppercase preferred.'),
    baseChain: z.enum(['ethereum', 'sepolia', 'bitcoin', 'bitcoin-signet', 'sui', 'sui-testnet']).optional().describe('Chain the base token settles on. Inference defaults: ETH/USDC/USDT/WBTC/WETH→"ethereum", BTC→"bitcoin", SUI→"sui". Override to testnet ONLY on explicit user mention ("sepolia", "signet", "testnet", "test", "sınama"). Required for SUI legs (no legacy fallback).'),
    quoteToken: z.string().describe('Quote asset symbol from the supported list. Same rules as baseToken.'),
    quoteChain: z.enum(['ethereum', 'sepolia', 'bitcoin', 'bitcoin-signet', 'sui', 'sui-testnet']).optional().describe('Chain the quote token settles on. Same inference rules as baseChain. Cross-environment pairs are allowed (e.g. baseChain="sui" + quoteChain="sepolia").'),
    side: z.enum(['BUY', 'SELL']).describe('BUY = user wants to acquire baseToken; SELL = user wants to dispose of baseToken. Map "sell/swap/exchange/liquidate/convert/sat" → SELL, "buy/acquire/al" → BUY.'),
    amount: z.string().describe('Amount of base token as a raw decimal string ("0.1", "1.5", "10"). Do NOT convert to wei/satoshis. Reject USD-denominated values — ask user for base-token amount instead.'),
    expiresIn: z.number().optional().describe('RFQ expiration in seconds. Default 300 (5 min). "Urgent" → 60-120. "Take your time" → 600-1800. Hard cap 86400 (24 h).'),
    isBlind: z.boolean().optional().describe('Ghost Auction mode — hides requester identity from bidders and losing counterparties. Default false. Set true on intent words: "ghost", "blind", "anonymous", "hide identity", "gizli". External brand: "Ghost Auction"; internal name retained for API/DB schema stability.'),
  },
  async ({ baseToken, baseChain, quoteToken, quoteChain, side, amount, expiresIn, isBlind }) => {
    const result = await hl.createRFQ({ baseToken, baseChain, quoteToken, quoteChain, side, amount, expiresIn, isBlind });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── respond_rfq ─────────────────────────────────────────────

server.tool(
  'respond_rfq',
  'Market maker tool — submit sealed-bid quotes to compete on price. Private from other makers, no information leakage. Submit a sealed-bid price quote to an open RFQ (market-maker side). USE WHEN: the MCP client is acting as a market maker and has decided to quote on an open RFQ. DO NOT USE WHEN: acting as an end-user buyer/seller — use create_rfq to request quotes instead. Non-custodial: no funds locked until trade accepted. Agent-friendly: autonomous market-making via MCP.',
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
