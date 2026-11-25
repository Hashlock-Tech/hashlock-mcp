import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { okContent } from './result.js';

/**
 * What the client behind this request can show the person, read the way the SDK's own gate reads it before it lets an
 * ask through (-32021 otherwise): the capabilities on a 2026-07-28 request's envelope, else the ones its 2025-era
 * connection declared at initialize. The hosted server serves a 2025-era request from a fresh instance that never saw
 * an initialize, so that client reads as able to show neither and is never asked. A bare `elicitation: {}` is form.
 */
export function elicitation(server: McpServer, ctx: ServerContext): { form: boolean; url: boolean } {
  const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
  const e = (envelope ? envelope[CLIENT_CAPABILITIES_META_KEY] : server.server.getClientCapabilities())?.elicitation;
  return { form: !!e && (!!e.form || !e.url), url: !!e?.url };
}

/** The message the person confirms, from what the API holds; null when this call commits to nothing. Throws when the terms cannot be read or the tool would refuse the call. */
export type Describe<A> = (args: A) => Promise<string | null>;
type Handler<A> = (args: A, ctx: ServerContext) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>;

/**
 * The one gate in front of every tool that commits the person to a price or sends their money. A client that can show
 * a form gets `describe`'s message and one box titled `action` before `run` writes anything; the client retries the call
 * with the answer and this runs again (stateless), or, on a 2025-era stdio connection, the SDK's shim asks and re-enters.
 * Any answer decides once: a ticked box runs `run`; declined, cancelled, unticked or content that is not this form's
 * sends nothing, and is never asked again. Terms that cannot be read, or a call the tool would refuse: nothing is sent.
 * A client that cannot be asked gets `run` as before.
 * No signed requestState binds the answer to the arguments: a client that does not cooperate skips the form anyway by not
 * declaring elicitation. The gate guards a person on a cooperating client from the model; the accept routes refuse a moved price.
 */
export function confirmFirst<A>(server: McpServer, action: string, describe: Describe<A>, run: Handler<A>): Handler<A> {
  const answer = z.object({ confirm: z.boolean().meta({ title: action }) });
  return async (args, ctx) => {
    if (!elicitation(server, ctx).form) return run(args, ctx);
    if (ctx.mcpReq.inputResponses?.confirm !== undefined) {
      return acceptedContent(ctx.mcpReq.inputResponses, 'confirm', answer)?.confirm === true
        ? run(args, ctx)
        : okContent({ declined: true, message: 'The person did not confirm: nothing was sent.' });
    }
    let message: string | null;
    try {
      message = await describe(args);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Nothing was sent, and the person was not asked: ${why}` }], isError: true };
    }
    if (message === null) return run(args, ctx);
    return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: answer }) } });
  };
}

// ── the terms in words ─────────────────────────────────────────────────────────────────────────────────────────
/** An asset as the registry lists it, or by id alone: a closed one is not listed, and the thread names only its id. */
export type Shown = { symbol: string; chain: string; decimals: number } | { id: string };

/** A base-unit amount in human units, thousands grouped: ("30000000000", 6) → "30,000". */
export function human(base: string | bigint, decimals: number): string {
  const n = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const frac = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${(n / d).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
const chainName = (chain: string) => chain.charAt(0).toUpperCase() + chain.slice(1);
/** An id as the person can match it on the site: its first eight characters. */
export const short = (id: string) => `${id.slice(0, 8)}…`;
/** "USDC on Ethereum". */
const named = (a: Shown) => ('symbol' in a ? `${a.symbol} on ${chainName(a.chain)}` : `asset ${short(a.id)}, which is not open for trading`);
/** "30,000 USDC on Ethereum"; an unlisted asset in its base units. */
export const amountOf = (base: string | bigint, a: Shown) => ('symbol' in a ? `${human(base, a.decimals)} ${named(a)}` : `${BigInt(base)} base units of ${named(a)}`);

/**
 * The protocol fee as the API computes it (packages/api/src/rfq/fee.ts protocolFeeForLeg): floor(gross × bps / 10 000)
 * of the leg the requester gives, waived on Bitcoin below the 546-sat dust limit.
 */
function protocolFee(gross: string | bigint, bps: number, bitcoin: boolean): bigint {
  const fee = (BigInt(gross) * BigInt(bps)) / 10_000n;
  return bitcoin && fee < 546n ? 0n : fee;
}
/** The fee rule for the requester's give leg: the API's current rate, and whether that leg is on Bitcoin. */
type Fee = { bps: number; bitcoin: boolean };
/** ", plus a protocol fee of 30 USDC (0.1%) that is not refunded," — the requester pays it on top of what it gives. */
function feeOn(amount: string | null, a: Shown, f: Fee): string {
  const rate = `${f.bps / 100}%`;
  if (amount === null) return f.bps ? `, plus a protocol fee of ${rate} of that price${f.bitcoin ? ' (none below 546 sats)' : ''} that is not refunded,` : ', with no protocol fee,';
  const fee = protocolFee(amount, f.bps, f.bitcoin);
  if (!fee) return ', with no protocol fee,';
  return `, plus a protocol fee of ${'symbol' in a ? `${human(fee, a.decimals)} ${a.symbol}` : `${fee} base units`} (${rate}) that is not refunded,`;
}

/**
 * What one side of a request gives and receives. The requester gives the base asset when it sells it (sell_base); the
 * maker who quotes takes the other side. A quote amount not set yet (a public request) is the price agreed later.
 * `fee`: the caller is the requester, who pays the protocol fee in the asset it gives.
 */
export function trade(t: { direction: 'sell_base' | 'buy_base'; requester: boolean; base: Shown; baseAmount: string; quote: Shown; quoteAmount: string | null; fee?: Fee }): string {
  const base = { amount: t.baseAmount as string | null, asset: t.base };
  const quote = { amount: t.quoteAmount, asset: t.quote };
  const [give, get] = (t.direction === 'sell_base') === t.requester ? [base, quote] : [quote, base];
  const side = (s: typeof base) => (s.amount ? amountOf(s.amount, s.asset) : `${named(s.asset)} at a price agreed later`);
  return `you give ${side(give)}${t.fee ? feeOn(give.amount, give.asset, t.fee) : ''} and receive ${side(get)}`;
}

/**
 * The message for each commitment both servers gate, so they say the same thing. `terms` is trade()'s. `onPage`: the
 * person is the initiator on a chat assistant's key, so their quote or counter is not yet their agreement: they accept
 * on the deal page, whose browser makes the secret.
 */
export const says = {
  /** `target`: the wallet a private order is reserved for; the API drops it from a public request, as it drops the ask. */
  request: (terms: string, o: { private: boolean; target?: string | null }) =>
    `${o.private ? `Post a private order${o.target ? `, reserved for ${o.target}` : ''}` : 'Post a request'}: ${terms}. Nothing binds you until you accept a quote.`,
  quote: (rfqId: string, terms: string, onPage = false) =>
    `Quote request ${short(rfqId)}: ${terms}. ` +
    (onPage
      ? 'As the initiator you are not bound by this quote: you agree only when you accept the deal on its page.'
      : 'This binds you to this price: if the requester accepts, the deal is agreed.'),
  counter: (threadId: string, terms: string, onPage = false) =>
    `Counter on deal ${short(threadId)}: ${terms}. ` +
    (onPage
      ? 'As the initiator you are not bound by this counter: you agree only when you accept the deal on its page.'
      : 'This binds you to this price: if the counterparty takes it, the deal is agreed.'),
  take: (threadId: string, terms: string, accept: boolean, onPage = false) =>
    `Take the counterparty's price on deal ${short(threadId)}: ${terms}. ` +
    (accept ? 'This agrees the deal at this price.' : onPage ? 'You accept the deal itself on its page.' : 'You accept the deal itself in a further step.'),
  accept: (threadId: string, terms: string) => `Accept deal ${short(threadId)}: ${terms}. This agrees the deal at this price; once both sides have accepted, each funds its leg.`,
  /**
   * An address the caller sets on a swap, by the API's column rule (packages/api/src/rfq/service.ts addressColumn): on
   * the leg it receives (the taker leg a, the maker leg b) it is where that leg pays; on the leg it funds, the refund.
   * On EVM and TRON a refund goes back to the wallet that funded, so there it names that wallet. Throws where the API
   * would refuse the chain or leg, or a Bitcoin refund given anything but a compressed public key (setSwapAddress: "a
   * Bitcoin refund is set by your wallet's key").
   */
  address: (
    swap: { id: string; makerId: string; takerId: string; aChain: string; bChain: string },
    me: string,
    a: { chain: string; address: string; leg?: 'a' | 'b' },
    family: string,
  ) => {
    if (me !== swap.makerId && me !== swap.takerId) throw new Error('you are not a party to this swap');
    const [onA, onB] = [a.chain === swap.aChain, a.chain === swap.bChain];
    if (!onA && !onB) throw new Error(`${a.chain} is not a chain of this swap`);
    if (a.leg && !(a.leg === 'a' ? onA : onB)) throw new Error(`leg ${a.leg} of this swap is not on ${a.chain}`);
    if (onA && onB && !a.leg) throw new Error(`both legs of this swap are on ${a.chain}: say which leg (a or b) this address is for`);
    const payout = ((a.leg ?? (onA ? 'a' : 'b')) === 'a') === (me === swap.takerId);
    const where = `swap ${short(swap.id)} on ${chainName(a.chain)}${a.leg ? `, leg ${a.leg},` : ''}`;
    // A Bitcoin payout takes the wallet's public key, or an address its claim pays; a Bitcoin refund only the key.
    const btc = family === 'bitcoin' || family === 'btc';
    const key = btc && /^0[23][0-9a-f]{64}$/i.test(a.address);
    const to = key ? `the wallet of key ${a.address}` : a.address;
    if (payout) return `Payouts for ${where} go to ${to}.`;
    if (btc && !key) throw new Error("a Bitcoin refund is set by your wallet's key: send its compressed public key (66 hex), not an address");
    if (['evm', 'tvm', 'tron'].includes(family)) return `Your leg of ${where} is funded from ${to}, and a refund goes back to it.`;
    return `Refunds of your leg of ${where} go to ${to}.`;
  },
};
