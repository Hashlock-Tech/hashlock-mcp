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

/** Fail-closed money-input grammar: a positive decimal string with no commas,
 *  no scientific notation, no sign, no bare leading dot. Mirrors the backend
 *  `positiveAmount` grammar so an ill-formed quote/limit can never be selected.
 *  compareDecimal stays a total order on well-formed input — this guards it. */
export function isPositiveDecimal(s: string): boolean {
  return /^\d+(\.\d+)?$/.test((s ?? '').trim());
}

/** Eligible = PENDING, well-formed price+amount, and amount covers the request
 *  (full-fill v1). SELL → max price; BUY → min price. null if none. */
export function selectBestBid(quotes: SwapQuote[], side: Side, requestedAmount: string): SwapQuote | null {
  const eligible = quotes.filter(
    (x) => x.status === SELECTABLE_QUOTE
      && isPositiveDecimal(x.price) && isPositiveDecimal(x.amount)
      && compareDecimal(x.amount, requestedAmount) >= 0,
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
  // still_open must reflect a POST-poll status: the RFQ can expire during the
  // bounded wait when the agent set expiresIn <= the wait window. The caller
  // owns this RFQ (just created it) so a forbidden throw is not expected here;
  // still, a status-refresh failure is advisory-only and must not break the
  // quote response — fall back to the create-time status.
  let latestStatus = rfq.status;
  try {
    const latest = await client.getRFQ(rfq.id);
    if (latest) latestStatus = latest.status;
  } catch {
    // status refresh is advisory-only; fall back to the create-time status
  }
  return okContent({
    swap_handle: rfq.id,
    status: best ? 'QUOTED' : 'OPEN',
    best_bid: bidView(best),
    bids_seen: quotes.length,
    still_open: RFQ_OPEN_STATES.has(latestStatus),
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
  let rfq: SwapRfq | null;
  try {
    rfq = await client.getRFQ(args.swap_handle);
  } catch (err) {
    // Uniform not-found contract: a forbidden/unauthorized RFQ (exists but the
    // caller is not a participant) must NOT be distinguishable from a
    // non-existent one, or swap_handle becomes an existence/participant oracle.
    const msg = err instanceof Error ? err.message : String(err);
    if (/forbidden|not a participant|unauthor|\b401\b|\b403\b/i.test(msg)) {
      return okContent({ outcome: 'SWAP_NOT_FOUND', swap_handle: args.swap_handle,
        next: 'Verify the swap_handle, or open a fresh swap with swap_quote.' });
    }
    throw err;
  }
  if (!rfq) {
    return okContent({ outcome: 'SWAP_NOT_FOUND', swap_handle: args.swap_handle,
      next: 'Verify the swap_handle, or open a fresh swap with swap_quote.' });
  }
  if (!RFQ_OPEN_STATES.has(rfq.status)) {
    return okContent({ outcome: 'SWAP_NOT_OPEN', swap_handle: args.swap_handle, rfq_status: rfq.status,
      next: 'This swap can no longer be executed. Open a fresh swap with swap_quote.' });
  }
  if (args.quote_id && args.limit_price !== undefined) {
    return okContent({ outcome: 'INVALID_EXECUTION_PARAMS', swap_handle: args.swap_handle,
      next: 'Provide EXACTLY ONE of quote_id (take that exact bid) or limit_price (auto-take best within your bound) — not both. They are distinct confirmation modes; passing both is ambiguous on a real-funds accept.' });
  }
  if (!args.quote_id && args.limit_price === undefined) {
    return okContent({ outcome: 'CONFIRMATION_REQUIRED', swap_handle: args.swap_handle,
      next: 'Real funds. Re-call swap_execute with EITHER limit_price (auto-takes best bid iff it meets your bound) OR quote_id (from swap_status best_bid.quote_id) to confirm the exact price.' });
  }
  const quotes = await client.getQuotes(args.swap_handle);

  let chosen: SwapQuote | null;
  if (args.quote_id) {
    chosen = quotes.find(
      (x) => x.id === args.quote_id && x.status === SELECTABLE_QUOTE
        && isPositiveDecimal(x.price) && isPositiveDecimal(x.amount)
        && compareDecimal(x.amount, rfq.amount) >= 0,
    ) ?? null;
    if (!chosen) {
      return okContent({ outcome: 'QUOTE_NOT_AVAILABLE', swap_handle: args.swap_handle, quote_id: args.quote_id,
        next: 'That quote expired or was outbid. Re-check live bids with swap_status.' });
    }
  } else {
    // limit_price is defined here (the no-args case returned CONFIRMATION_REQUIRED above).
    if (!isPositiveDecimal(args.limit_price as string)) {
      return okContent({ outcome: 'INVALID_LIMIT_PRICE', swap_handle: args.swap_handle,
        limit_price: args.limit_price,
        next: 'limit_price must be a positive decimal string like "3450.00" — no commas, no scientific notation, no negative.' });
    }
    const best = selectBestBid(quotes, rfq.side, rfq.amount);
    if (!best) {
      return okContent({ outcome: 'NO_ACCEPTABLE_FILL', swap_handle: args.swap_handle, best_price: null,
        limit_price: args.limit_price, side: rfq.side, bids_seen: quotes.length,
        next: 'No eligible bids yet. swap_status to wait, or swap_cancel.' });
    }
    if (!limitSatisfied(best.price, args.limit_price as string, rfq.side)) {
      return okContent({ outcome: 'NO_ACCEPTABLE_FILL', swap_handle: args.swap_handle, best_price: best.price,
        limit_price: args.limit_price, side: rfq.side, bids_seen: quotes.length,
        next: 'Best bid does not meet your limit. swap_status to wait for better, or swap_cancel.' });
    }
    chosen = best;
  }

  if (!chosen) throw new Error('invariant: chosen must be set before accept');
  // Idempotency key is composed at the index.ts tool handler (Layer-1 pattern); this fn receives a pre-bound Remember.
  const accept = await remember(() => client.acceptQuote(chosen.id));
  return okContent({
    trade_id: accept.trade?.id ?? null,
    rfq_id: accept.rfqId,
    accepted_price: chosen.price,
    accepted_amount: chosen.amount,
    status: accept.status,
    next: 'Settle on-chain: create_htlc -> get_htlc -> withdraw_htlc (or refund_htlc after timelock).',
  });
}

export interface SwapCancelArgs { swap_handle: string; client_request_id?: string; }

export async function runSwapCancel(
  client: SwapClient, args: SwapCancelArgs, remember: Remember,
): Promise<ToolContent> {
  // Idempotency key is composed at the index.ts tool handler (Layer-1 pattern);
  // this fn receives a pre-bound Remember.
  let res: { id: string; status: string };
  try {
    res = await remember(() => client.cancelRFQ(args.swap_handle));
  } catch (err) {
    // Uniform not-found contract (parity with runSwapExecute/runSwapStatus): a
    // forbidden/unauthorized RFQ (exists but caller is not a participant) must
    // NOT be distinguishable from a non-existent one — no existence/participant
    // oracle via swap_cancel.
    const msg = err instanceof Error ? err.message : String(err);
    if (/forbidden|not a participant|unauthor|\b401\b|\b403\b/i.test(msg)) {
      return okContent({ outcome: 'SWAP_NOT_FOUND', swap_handle: args.swap_handle,
        next: 'Verify the swap_handle, or open a fresh swap with swap_quote.' });
    }
    throw err;
  }
  return okContent({ swap_handle: res.id, status: res.status,
    next: 'Swap aborted. No funds were locked. Open a new swap with swap_quote when ready.' });
}

export interface SwapStatusArgs { swap_handle: string; max_wait_seconds?: number; }

export async function runSwapStatus(
  client: SwapClient, args: SwapStatusArgs, sleep: Sleep,
): Promise<ToolContent> {
  let rfq: SwapRfq | null;
  try {
    rfq = await client.getRFQ(args.swap_handle);
  } catch (err) {
    // Uniform not-found contract (same as runSwapExecute): a forbidden/unauthorized
    // RFQ (exists but caller is not a participant) must NOT be distinguishable from
    // a non-existent one, or swap_handle becomes an existence/participant oracle.
    const msg = err instanceof Error ? err.message : String(err);
    if (/forbidden|not a participant|unauthor|\b401\b|\b403\b/i.test(msg)) {
      return okContent({ outcome: 'SWAP_NOT_FOUND', swap_handle: args.swap_handle,
        next: 'Verify the swap_handle, or open a fresh swap with swap_quote.' });
    }
    throw err;
  }
  if (!rfq) {
    return okContent({ outcome: 'SWAP_NOT_FOUND', swap_handle: args.swap_handle,
      next: 'Verify the swap_handle, or open a fresh swap with swap_quote.' });
  }
  const open = RFQ_OPEN_STATES.has(rfq.status);
  const quotes = open
    ? await pollForQuotes(client, rfq.id, rfq.side, rfq.amount, args.max_wait_seconds ?? 15, sleep)
    : await client.getQuotes(rfq.id);
  const best = selectBestBid(quotes, rfq.side, rfq.amount);
  return okContent({
    swap_handle: rfq.id,
    status: best ? 'QUOTED' : 'OPEN',
    rfq_status: rfq.status,
    best_bid: bidView(best),
    bids_seen: quotes.length,
    still_open: open,
    next: best
      ? 'swap_execute with this swap_handle + your limit_price (or best_bid.quote_id).'
      : open ? 'Still waiting on bids. Call swap_status again, or swap_cancel.'
             : 'This swap is closed. Open a fresh one with swap_quote.',
  });
}
