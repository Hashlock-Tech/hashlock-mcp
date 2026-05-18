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
