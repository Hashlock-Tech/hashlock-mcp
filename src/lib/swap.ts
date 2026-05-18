import { okContent, type ToolContent } from './result.js';

export type Side = 'BUY' | 'SELL';

export interface SwapQuote {
  id: string; rfqId: string; marketMakerId: string;
  price: string; amount: string;
  status: string;                 // QuoteStatus: PENDING|ACCEPTED|REJECTED|EXPIRED
  expiresAt?: string | null; createdAt?: string;
}

export interface SwapRfq {
  id: string; side: Side; amount: string;
  status: string;                 // RFQStatus: ACTIVE|QUOTES_RECEIVED|ACCEPTED|FILLED|EXPIRED|CANCELLED
  isBlind?: boolean; baseToken?: string; quoteToken?: string;
  expiresAt?: string | null;
}

export interface SwapClient {
  createRFQ(input: unknown): Promise<{ id: string; status: string }>;
  getRFQ(id: string): Promise<SwapRfq | null>;
  getQuotes(rfqId: string): Promise<SwapQuote[]>;
  acceptQuote(quoteId: string): Promise<{ id: string; rfqId: string; status: string; trade?: { id: string; status: string } | null }>;
  cancelRFQ(id: string): Promise<{ id: string; status: string }>;
}

export type Remember = <T>(op: () => Promise<T>) => Promise<T>;
export type Sleep = (ms: number) => Promise<void>;

const RFQ_OPEN_STATES = new Set(['ACTIVE', 'QUOTES_RECEIVED']);
const SELECTABLE_QUOTE = 'PENDING';
const POLL_INTERVAL_MS = 2500;
const MAX_WAIT_CAP_S = 25;

/** Compare two non-negative decimal strings. Returns -1 | 0 | 1.
 *  String-based (digit-wise) — never parseFloat: token amounts can be
 *  18-decimal wei-scale where float loses precision. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const norm = (s: string): [string, string] => {
    const [intPartRaw, fracRaw = ''] = s.trim().split('.');
    const intPart = intPartRaw.replace(/^0+(?=\d)/, '') || '0';
    return [intPart, fracRaw.replace(/0+$/, '')];
  };
  const [ai, af] = norm(a);
  const [bi, bf] = norm(b);
  if (ai.length !== bi.length) return ai.length > bi.length ? 1 : -1;
  if (ai !== bi) return ai > bi ? 1 : -1;
  const fl = Math.max(af.length, bf.length);
  const ap = af.padEnd(fl, '0');
  const bp = bf.padEnd(fl, '0');
  if (ap === bp) return 0;
  return ap > bp ? 1 : -1;
}

/** Directional reservation gate. SELL: limit is a FLOOR (accept best >= limit).
 *  BUY: limit is a CEILING (accept best <= limit). */
export function limitSatisfied(bestPrice: string, limitPrice: string, side: Side): boolean {
  const cmp = compareDecimal(bestPrice, limitPrice);
  return side === 'SELL' ? cmp >= 0 : cmp <= 0;
}

/** Eligible = PENDING and amount covers the request (full-fill v1).
 *  SELL → max price; BUY → min price. null if none. */
export function selectBestBid(quotes: SwapQuote[], side: Side, requestedAmount: string): SwapQuote | null {
  const eligible = quotes.filter(
    (x) => x.status === SELECTABLE_QUOTE && compareDecimal(x.amount, requestedAmount) >= 0,
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, x) => {
    const c = compareDecimal(x.price, best.price);
    if (side === 'SELL') return c > 0 ? x : best;
    return c < 0 ? x : best;
  });
}

/** Poll getQuotes until an eligible bid exists or the bounded window elapses.
 *  Window clamped to [0, 25]s (kept under the 30s SDK client timeout).
 *  Clock injected (sleep) so tests are deterministic and instant. */
export async function pollForQuotes(
  client: SwapClient, rfqId: string, side: Side, requestedAmount: string,
  maxWaitSeconds: number, sleep: Sleep,
): Promise<SwapQuote[]> {
  const capped = Math.max(0, Math.min(MAX_WAIT_CAP_S, Math.floor(maxWaitSeconds || 0)));
  const iterations = Math.max(1, Math.ceil((capped * 1000) / POLL_INTERVAL_MS) + 1);
  let quotes: SwapQuote[] = [];
  for (let i = 0; i < iterations; i++) {
    quotes = await client.getQuotes(rfqId);
    if (selectBestBid(quotes, side, requestedAmount)) return quotes;
    if (i < iterations - 1) await sleep(POLL_INTERVAL_MS);
  }
  return quotes;
}

export interface SwapQuoteArgs {
  side: Side; baseToken: string; baseChain?: string;
  quoteToken: string; quoteChain?: string; amount: string;
  limit_price?: string; private?: boolean; expiresIn?: number;
  max_wait_seconds?: number; client_request_id?: string;
}
export interface SwapDeps { sleep: Sleep; remember: Remember; }

function bidView(q: SwapQuote | null) {
  return q ? { quote_id: q.id, price: q.price, amount: q.amount, expires_at: q.expiresAt ?? null } : null;
}

export async function runSwapQuote(
  client: SwapClient, args: SwapQuoteArgs, deps: SwapDeps,
): Promise<ToolContent> {
  // Mirror create_rfq EXACTLY: same input object incl. baseChain/quoteChain.
  // limit_price is deliberately NOT part of this object (sealed reservation).
  const rfqInput = {
    baseToken: args.baseToken, baseChain: args.baseChain,
    quoteToken: args.quoteToken, quoteChain: args.quoteChain,
    side: args.side, amount: args.amount,
    expiresIn: args.expiresIn ?? 300,
    isBlind: args.private ?? true,
  };
  const rfq = await deps.remember(() => client.createRFQ(rfqInput));
  const quotes = await pollForQuotes(
    client, rfq.id, args.side, args.amount, args.max_wait_seconds ?? 20, deps.sleep,
  );
  const best = selectBestBid(quotes, args.side, args.amount);
  return okContent({
    swap_handle: rfq.id,
    status: best ? 'QUOTED' : 'OPEN',
    best_bid: bidView(best),
    bids_seen: quotes.length,
    still_open: RFQ_OPEN_STATES.has(rfq.status),
    limit_price: args.limit_price ?? null,
    next: best
      ? 'swap_execute with this swap_handle + your limit_price (or best_bid.quote_id) to take it; or swap_status to let competition build; or swap_cancel to abort.'
      : 'No bids yet. Call swap_status to keep waiting, or swap_cancel to abort.',
  });
}

export interface SwapExecuteArgs {
  swap_handle: string; limit_price?: string; quote_id?: string; client_request_id?: string;
}

export async function runSwapExecute(
  client: SwapClient, args: SwapExecuteArgs, remember: Remember,
): Promise<ToolContent> {
  const rfq = await client.getRFQ(args.swap_handle);
  if (!rfq) {
    return okContent({ outcome: 'SWAP_NOT_FOUND', swap_handle: args.swap_handle,
      next: 'Verify the swap_handle, or open a fresh swap with swap_quote.' });
  }
  if (!RFQ_OPEN_STATES.has(rfq.status)) {
    return okContent({ outcome: 'SWAP_NOT_OPEN', swap_handle: args.swap_handle, rfq_status: rfq.status,
      next: 'This swap can no longer be executed. Open a fresh swap with swap_quote.' });
  }
  const quotes = await client.getQuotes(args.swap_handle);

  let chosen: SwapQuote | null;
  if (args.quote_id) {
    chosen = quotes.find(
      (x) => x.id === args.quote_id && x.status === SELECTABLE_QUOTE
        && compareDecimal(x.amount, rfq.amount) >= 0,
    ) ?? null;
    if (!chosen) {
      return okContent({ outcome: 'QUOTE_NOT_AVAILABLE', swap_handle: args.swap_handle, quote_id: args.quote_id,
        next: 'That quote expired or was outbid. Re-check live bids with swap_status.' });
    }
  } else if (args.limit_price !== undefined) {
    const best = selectBestBid(quotes, rfq.side, rfq.amount);
    if (!best) {
      return okContent({ outcome: 'NO_ACCEPTABLE_FILL', swap_handle: args.swap_handle, best_price: null,
        limit_price: args.limit_price, side: rfq.side, bids_seen: quotes.length,
        next: 'No eligible bids yet. swap_status to wait, or swap_cancel.' });
    }
    if (!limitSatisfied(best.price, args.limit_price, rfq.side)) {
      return okContent({ outcome: 'NO_ACCEPTABLE_FILL', swap_handle: args.swap_handle, best_price: best.price,
        limit_price: args.limit_price, side: rfq.side, bids_seen: quotes.length,
        next: 'Best bid does not meet your limit. swap_status to wait for better, or swap_cancel.' });
    }
    chosen = best;
  } else {
    return okContent({ outcome: 'CONFIRMATION_REQUIRED', swap_handle: args.swap_handle,
      next: 'Real funds. Re-call swap_execute with EITHER limit_price (auto-takes best bid iff it meets your bound) OR quote_id (from swap_status best_bid.quote_id) to confirm the exact price.' });
  }

  const accept = await remember(() => client.acceptQuote(chosen!.id));
  return okContent({
    trade_id: accept.trade?.id ?? null,
    rfq_id: accept.rfqId,
    accepted_price: chosen.price,
    accepted_amount: chosen.amount,
    status: accept.status,
    next: 'Settle on-chain: create_htlc -> get_htlc -> withdraw_htlc (or refund_htlc after timelock).',
  });
}
