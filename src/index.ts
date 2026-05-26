import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HashLock } from '@hashlock-tech/sdk';
import { okContent } from './lib/result.js';
import { wrapTool } from './lib/errors.js';
import { SUPPORTED_PAIRS } from './lib/pairs.js';
import { createIdempotencyGuard, idempotencyKey } from './lib/idempotency.js';
import {
  runSwapQuote, runSwapStatus, runSwapExecute, runSwapCancel,
  type SwapClient,
} from './lib/swap.js';
import { createComputeCapacityListingTool, createComputeCapacityRfqShape } from './tools/compute/create_compute_capacity_listing.js';

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

const idempotency = createIdempotencyGuard();

const server = new McpServer({
  name: 'hashlock',
  version: '0.4.0',
});

// ─── create_htlc ─────────────────────────────────────────────

server.tool(
  'create_htlc',
  [
    'Trustless atomic settlement — delivery vs payment (DVP) guarantee. Both sides receive their asset OR both get refunded; zero counterparty risk, zero slippage, no custodian. Records the on-chain HTLC lock tx hash to advance the settlement state machine.',
    '',
    'USE WHEN: a trade is accepted and the user has just broadcast the lock transaction on-chain (EVM, Bitcoin, or Sui).',
    'DO NOT USE WHEN: the trade is not yet accepted, or the lock tx has not been broadcast yet — submit the on-chain tx first, then call this tool.',
    '',
    'PARAM NOTES: `role` must be INITIATOR (you locked first) or COUNTERPARTY (you locked in response). `txHash` must be 0x-prefixed. `chainType` defaults to evm — set "bitcoin" or "sui" for non-EVM legs.',
  ].join('\n'),
  {
    tradeId: z.string().describe('Trade ID from an accepted trade'),
    txHash: z.string().describe('On-chain transaction hash of the HTLC lock (0x-prefixed)'),
    role: z.enum(['INITIATOR', 'COUNTERPARTY']).describe('Your role in the trade'),
    timelock: z.number().optional().describe('HTLC expiry as Unix timestamp'),
    hashlock: z.string().optional().describe('SHA-256 hashlock (0x-prefixed hex)'),
    chainType: z.string().optional().describe('Chain type: evm, bitcoin, or sui'),
    preimage: z.string().optional().describe('Secret preimage (only for initiator)'),
    client_request_id: z.string().optional().describe('Idempotency key. Retrying the SAME write with the SAME id within this MCP session returns the first result instead of triggering a second on-chain/backend side effect. Best-effort: not durable across MCP restarts.'),
  },
  wrapTool(async ({ tradeId, txHash, role, timelock, hashlock, chainType, preimage, client_request_id }) => {
    const input = { tradeId, txHash, role, timelock, hashlock, chainType, preimage };
    const result = await idempotency.remember(idempotencyKey('create_htlc', client_request_id, input), () =>
      hl.fundHTLC(input));
    return okContent(result);
  }),
);

// ─── withdraw_htlc ───────────────────────────────────────────

server.tool(
  'withdraw_htlc',
  [
    'Atomic claim — reveals the 32-byte preimage to unlock both legs of the swap simultaneously. Trustless cross-chain finality: no intermediary holds funds at any point.',
    '',
    'USE WHEN: counterparty has confirmed their lock on-chain and the user wants to claim their side of the swap.',
    'DO NOT USE WHEN: counterparty lock is not yet confirmed on-chain, OR the timelock has already expired — use refund_htlc instead.',
    '',
    'PARAM NOTES: `preimage` must be 0x-prefixed 32-byte hex. Revealing the preimage is what makes the swap atomic — it simultaneously unlocks the counterparty leg. Set `chainType` to "bitcoin" or "sui" for non-EVM legs.',
  ].join('\n'),
  {
    tradeId: z.string().describe('Trade ID'),
    txHash: z.string().describe('On-chain claim transaction hash (0x-prefixed)'),
    preimage: z.string().describe('The 32-byte secret preimage (0x-prefixed hex)'),
    chainType: z.string().optional().describe('Chain type: evm, bitcoin, or sui'),
    client_request_id: z.string().optional().describe('Idempotency key. Retrying the SAME write with the SAME id within this MCP session returns the first result instead of triggering a second on-chain/backend side effect. Best-effort: not durable across MCP restarts.'),
  },
  wrapTool(async ({ tradeId, txHash, preimage, chainType, client_request_id }) => {
    const input = { tradeId, txHash, preimage, chainType };
    const result = await idempotency.remember(idempotencyKey('withdraw_htlc', client_request_id, input), () =>
      hl.claimHTLC(input));
    return okContent(result);
  }),
);

// ─── refund_htlc ─────────────────────────────────────────────

server.tool(
  'refund_htlc',
  [
    'Trustless unwind — recover locked funds after the HTLC timelock expires. Non-custodial refund guarantee: if the swap does not complete, the original sender reclaims their asset with zero counterparty risk.',
    '',
    'USE WHEN: the timelock deadline has passed AND the counterparty never locked their side (or the swap otherwise failed to complete).',
    'DO NOT USE WHEN: counterparty HAS locked and the swap can still complete — use withdraw_htlc instead. Only the original lock sender can call refund, and only after the deadline.',
    '',
    'PARAM NOTES: `txHash` is the on-chain refund tx hash (0x-prefixed). No preimage needed — expiry alone unlocks the refund path. Set `chainType` to "bitcoin" or "sui" for non-EVM legs.',
  ].join('\n'),
  {
    tradeId: z.string().describe('Trade ID'),
    txHash: z.string().describe('On-chain refund transaction hash (0x-prefixed)'),
    chainType: z.string().optional().describe('Chain type: evm, bitcoin, or sui'),
    client_request_id: z.string().optional().describe('Idempotency key. Retrying the SAME write with the SAME id within this MCP session returns the first result instead of triggering a second on-chain/backend side effect. Best-effort: not durable across MCP restarts.'),
  },
  wrapTool(async ({ tradeId, txHash, chainType, client_request_id }) => {
    const input = { tradeId, txHash, chainType };
    const result = await idempotency.remember(idempotencyKey('refund_htlc', client_request_id, input), () =>
      hl.refundHTLC(input));
    return okContent(result);
  }),
);

// ─── get_htlc ────────────────────────────────────────────────

server.tool(
  'get_htlc',
  [
    'Real-time trade observability — per-leg HTLC settlement state for a trade: which legs are locked, on which chain, with what timelock, and whether the preimage has been revealed. Read-only, safe to call at any time.',
    '',
    'Returns an ARRAY of HTLC legs (one entry per locked leg, typically the initiator leg and the counterparty leg). An empty array means no HTLC has been recorded for this tradeId yet (or the tradeId does not exist) — treat empty as "nothing locked", not an error.',
    '',
    'USE WHEN: showing trade/settlement status to the user, deciding the next settlement action (lock / claim / refund), polling for the counterparty leg, or rebuilding state after losing context.',
    'DO NOT USE WHEN: you need RFQ/quote status (this is settlement-leg state only) — use list_my_trades or list_open_rfqs instead.',
    '',
    'INTERPRETING THE RESULT (per leg): `role` = INITIATOR | COUNTERPARTY; `status` = leg lifecycle; `chainType` = evm | bitcoin | sui; `timelock` = unix expiry of that leg; `preimage` non-null on a claimed initiator leg. Both legs ACTIVE = swap can complete (claim path). Initiator leg past `timelock` with counterparty leg absent = refund path.',
  ].join('\n'),
  {
    tradeId: z.string().describe('Trade ID to query HTLC legs for. An unknown ID returns an empty array, not an error.'),
  },
  wrapTool(async ({ tradeId }) => {
    const result = await hl.getHTLCs(tradeId);
    return okContent(result);
  }),
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
    client_request_id: z.string().optional().describe('Idempotency key. Retrying the SAME write with the SAME id within this MCP session returns the first result instead of triggering a second on-chain/backend side effect. Best-effort: not durable across MCP restarts.'),
  },
  wrapTool(async ({ baseToken, baseChain, quoteToken, quoteChain, side, amount, expiresIn, isBlind, client_request_id }) => {
    // TODO: SDK type def (CreateRFQInput) lags backend — baseChain/quoteChain
    // are accepted by the GraphQL `createRFQ` mutation but not yet typed in
    // @hashlock-tech/sdk@0.1.4. Cast to bypass DTS build; remove once SDK
    // bumps the input type. Tracked separately from the v2 positioning sweep.
    const input = { baseToken, baseChain, quoteToken, quoteChain, side, amount, expiresIn, isBlind } as Parameters<typeof hl.createRFQ>[0];
    const result = await idempotency.remember(idempotencyKey('create_rfq', client_request_id, input), () =>
      hl.createRFQ(input));
    return okContent(result);
  }),
);

// ─── list_supported_pairs ────────────────────────────────────

server.tool(
  'list_supported_pairs',
  [
    'List the chain-qualified token pairs Hashlock supports for RFQ/swap. Read-only, no auth side effects.',
    '',
    'USE WHEN: before create_rfq if unsure a token/chain is supported, or to show the user available markets instead of guessing.',
    'DO NOT USE WHEN: you already know the pair is supported — this is discovery, not a precondition.',
    '',
    'Each entry is SYMBOL/chain. Same symbol on different chains (e.g. SUI/sui vs SUI/sui-testnet) are distinct markets — pass baseChain/quoteChain explicitly to create_rfq.',
  ].join('\n'),
  {},
  wrapTool(async () => okContent({ pairs: SUPPORTED_PAIRS })),
);

// ─── respond_rfq ─────────────────────────────────────────────

server.tool(
  'respond_rfq',
  [
    'Market-maker tool — submit a sealed-bid price quote to compete on an open RFQ. Quotes are private: other makers cannot see your price, and losing bids are never revealed. No funds are locked until the requester accepts a quote.',
    '',
    'USE WHEN: the MCP client is acting as a market maker and has decided to quote on a specific open RFQ (obtained via list_open_rfqs).',
    'DO NOT USE WHEN: acting as an end-user buyer or seller who wants to receive quotes — use create_rfq instead. This is the market-maker side only; sealed bids, not open negotiation.',
    '',
    'PARAM NOTES: `price` is per unit of base token in quote-token terms (e.g. "3450.00" for ETH priced in USDT). `amount` is base-token amount offered. No funds are locked at quote time — settlement only begins when the requester accepts.',
  ].join('\n'),
  {
    rfqId: z.string().describe('ID of the RFQ to respond to'),
    price: z.string().describe('Price per unit of base token in quote token terms (e.g., "3450.00")'),
    amount: z.string().describe('Amount of base token to offer'),
    expiresIn: z.number().optional().describe('Quote expiration in seconds'),
    client_request_id: z.string().optional().describe('Idempotency key. Retrying the SAME write with the SAME id within this MCP session returns the first result instead of triggering a second on-chain/backend side effect. Best-effort: not durable across MCP restarts.'),
  },
  wrapTool(async ({ rfqId, price, amount, expiresIn, client_request_id }) => {
    const input = { rfqId, price, amount, expiresIn };
    const result = await idempotency.remember(idempotencyKey('respond_rfq', client_request_id, input), () =>
      hl.submitQuote(input));
    return okContent(result);
  }),
);

// ─── list_open_rfqs ──────────────────────────────────────────

server.tool(
  'list_open_rfqs',
  [
    'List currently open (ACTIVE) RFQs awaiting market-maker quotes. Read-only.',
    '',
    'USE WHEN: acting as a market-maker agent deciding what to quote on, or showing the user live demand. DO NOT USE WHEN: you want your own trade history (use list_my_trades).',
    '',
    'Returns a page of RFQs (id, baseToken, quoteToken, side, amount, isBlind, status, expiresAt). To quote, call respond_rfq with the rfqId.',
  ].join('\n'),
  {
    page: z.number().int().min(1).optional().describe('1-based page number. Default 1.'),
    pageSize: z.number().int().min(1).max(100).optional().describe('Page size, 1-100. Default 20.'),
  },
  wrapTool(async ({ page, pageSize }) => okContent(
    await hl.listRFQs({ status: 'ACTIVE', page: page ?? 1, pageSize: pageSize ?? 20 }),
  )),
);

// ─── list_my_trades ──────────────────────────────────────────

server.tool(
  'list_my_trades',
  [
    'List the caller\'s trades (active + historical). Read-only. Primary tool for rebuilding state after losing conversation context.',
    '',
    'USE WHEN: an agent restarted/lost context and must resync in-flight settlements, or showing the user their trade history. DO NOT USE WHEN: you need open market demand (use list_open_rfqs) or per-leg HTLC detail for one trade (use get_htlc).',
    '',
    'Optional status filter narrows the page. For settlement-leg detail on a specific trade, follow up with get_htlc(tradeId).',
  ].join('\n'),
  {
    status: z.string().optional().describe('Optional trade-status filter (e.g. ACTIVE, COMPLETED). Omit for all.'),
    page: z.number().int().min(1).optional().describe('1-based page number. Default 1.'),
    pageSize: z.number().int().min(1).max(100).optional().describe('Page size, 1-100. Default 20.'),
  },
  wrapTool(async ({ status, page, pageSize }) => okContent(
    await hl.listTrades({ status, page: page ?? 1, pageSize: pageSize ?? 20 } as Parameters<typeof hl.listTrades>[0]),
  )),
);

// The real HashLock instance structurally satisfies SwapClient; same cast
// style as the existing create_rfq / list_my_trades call sites.
const swapClient = hl as unknown as SwapClient;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── swap_quote ──────────────────────────────────────────────
server.tool(
  'swap_quote',
  [
    'One-call OTC swap intake for agents — opens a sealed-bid Ghost Auction under the hood and waits briefly for the first private market-maker bids, then hands back a swap_handle + the best bid so far. Async by design: there is NO public synchronous price (that is the privacy guarantee). Zero slippage: the bid you execute is the fill.',
    '',
    'USE WHEN: an agent/user wants to "just swap X for Y" and have the facade manage quote collection + best-bid selection + a price guard. Privacy-sensitive or large flow.',
    'DO NOT USE WHEN: the caller wants explicit market-maker-aware RFQ control and will pick/accept quotes itself — use create_rfq. Sub-second DEX fills — use a DEX aggregator.',
    '',
    'PARAM NOTES: `limit_price` is your sealed reservation — for SELL it is a FLOOR (min you will accept), for BUY a CEILING (max you will pay), per unit of base in quote-token terms. It is NEVER sent to makers. `private` defaults true (Ghost Auction ON — hides your identity from bidders); set false for an open auction. After this returns, call swap_execute (with the same limit_price, or best_bid.quote_id) to take it, swap_status to let competition build, or swap_cancel to abort. Real funds: restate the resolved deal to the user before executing.',
  ].join('\n'),
  {
    side: z.enum(['BUY', 'SELL']).describe('SELL = dispose of baseToken; BUY = acquire baseToken.'),
    baseToken: z.string().describe('Base asset symbol (see list_supported_pairs).'),
    baseChain: z.enum(['ethereum', 'sepolia', 'bitcoin', 'bitcoin-signet', 'sui', 'sui-testnet']).optional().describe('Chain the base token settles on.'),
    quoteToken: z.string().describe('Quote asset symbol.'),
    quoteChain: z.enum(['ethereum', 'sepolia', 'bitcoin', 'bitcoin-signet', 'sui', 'sui-testnet']).optional().describe('Chain the quote token settles on.'),
    amount: z.string().describe('Base-token amount as a raw decimal string ("0.1", "2"). Do NOT convert to wei/satoshis.'),
    limit_price: z.string().optional().describe('Sealed reservation. SELL=floor, BUY=ceiling, per unit of base in quote terms. Never sent to makers.'),
    private: z.boolean().optional().describe('Ghost Auction (hide requester identity). Default true. Set false for an open auction.'),
    expiresIn: z.number().optional().describe('RFQ lifetime seconds. Default 300. Hard cap 86400.'),
    max_wait_seconds: z.number().optional().describe('How long swap_quote waits for first bids. Default 20, capped 25.'),
    client_request_id: z.string().optional().describe('Idempotency key. Same id within this MCP session returns the first result instead of opening a second RFQ. Best-effort: not durable across restarts.'),
  },
  wrapTool(async (a) => {
    const input = { side: a.side, baseToken: a.baseToken, baseChain: a.baseChain, quoteToken: a.quoteToken, quoteChain: a.quoteChain, amount: a.amount, expiresIn: a.expiresIn, isBlind: a.private ?? true };
    return runSwapQuote(swapClient, a, {
      sleep: realSleep,
      remember: (op) => idempotency.remember(idempotencyKey('swap_quote', a.client_request_id, input), op),
    });
  }),
);

// ─── swap_status ─────────────────────────────────────────────
server.tool(
  'swap_status',
  [
    'Re-poll an open swap by its swap_handle — returns the current best sealed bid + how many bids are in. Read-only, stateless: the primary way to resume a swap after losing context (only the swap_handle is needed).',
    '',
    'USE WHEN: letting maker competition build before executing, or rebuilding an in-flight swap after a context reset. DO NOT USE WHEN: you need settlement-leg detail (use get_htlc) or your trade history (use list_my_trades).',
    '',
    'PARAM NOTES: returns best_bid (or null), bids_seen, still_open and rfq_status. When best_bid is present, swap_execute with the same limit_price (or best_bid.quote_id) to take it.',
  ].join('\n'),
  {
    swap_handle: z.string().describe('The swap_handle returned by swap_quote (the RFQ id).'),
    max_wait_seconds: z.number().optional().describe('Bounded wait for new bids this call. Default 15, capped 25.'),
  },
  wrapTool(async (a) => runSwapStatus(swapClient, a, realSleep)),
);

// ─── swap_execute ────────────────────────────────────────────
server.tool(
  'swap_execute',
  [
    'Accept the winning sealed bid for a swap and create the trade. Real funds. Provide EITHER limit_price (auto-takes the best bid only if it meets your bound) OR quote_id (the exact bid you saw via swap_status). With neither, this refuses (CONFIRMATION_REQUIRED) rather than guess — restate the price to the user first.',
    '',
    'USE WHEN: a swap has an acceptable bid and the user confirmed. DO NOT USE WHEN: you have not surfaced the price to the user, or you want maker-side quoting (use respond_rfq).',
    '',
    'PARAM NOTES: `limit_price` is the sealed reservation (SELL=floor, BUY=ceiling) and must be re-supplied here — it is deliberately never stored. WARNING: accepted_amount may EXCEED your requested amount if a maker quoted a larger size (full-fill v1 accepts a bid whose amount covers the request) — always reconcile accepted_amount against what you asked before settling on-chain. On success returns trade_id; settle on-chain next via create_htlc. This does NOT lock funds itself (non-custodial).',
  ].join('\n'),
  {
    swap_handle: z.string().describe('The swap_handle (RFQ id) from swap_quote.'),
    limit_price: z.string().optional().describe('Sealed reservation. SELL=floor, BUY=ceiling. Re-supply it here; never persisted.'),
    quote_id: z.string().optional().describe('Exact bid id from swap_status best_bid.quote_id (explicit-confirm path).'),
    client_request_id: z.string().optional().describe('Idempotency key. Same id within this session returns the first result instead of accepting twice. Best-effort.'),
  },
  wrapTool(async (a) => runSwapExecute(swapClient, a,
    (op) => idempotency.remember(idempotencyKey('swap_execute', a.client_request_id, { h: a.swap_handle, q: a.quote_id, l: a.limit_price }), op))),
);

// ─── swap_cancel ─────────────────────────────────────────────
server.tool(
  'swap_cancel',
  [
    'Abort an open swap before it executes (cancels the underlying RFQ). No funds were locked. Use when the limit never meets, the user changed their mind, or to clean up a stale swap_handle.',
    '',
    'USE WHEN: backing out of a swap_quote that has not been executed. DO NOT USE WHEN: the swap already executed (a trade exists) — settlement is governed by the HTLC timelock, not this tool.',
    '',
    'PARAM NOTES: idempotent within a session via client_request_id.',
  ].join('\n'),
  {
    swap_handle: z.string().describe('The swap_handle (RFQ id) to cancel.'),
    client_request_id: z.string().optional().describe('Idempotency key. Best-effort within this session.'),
  },
  wrapTool(async (a) => runSwapCancel(swapClient, a,
    (op) => idempotency.remember(idempotencyKey('swap_cancel', a.client_request_id, { h: a.swap_handle }), op))),
);

// ─── create_compute_capacity_listing ─────────────────────────

server.tool(
  createComputeCapacityListingTool.name,
  createComputeCapacityListingTool.description,
  createComputeCapacityRfqShape,
  wrapTool(async (args) => {
    const result = await createComputeCapacityListingTool.handler(
      args,
      { authToken: ACCESS_TOKEN },
    );
    // wrapTool expects ToolContent ({ content: [...] }); the tool returns
    // either { content, isError } or { content }. Strip isError so wrapTool
    // stays clean — errors were already rendered as human-readable text.
    return { content: result.content };
  }),
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
