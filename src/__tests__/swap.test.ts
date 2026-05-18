import { describe, it, expect } from 'vitest';
import { compareDecimal, limitSatisfied } from '../lib/swap.js';

describe('compareDecimal (string decimals, no float drift)', () => {
  it('orders integers and fractions without float error', () => {
    expect(compareDecimal('100.2', '100.19')).toBe(1);
    expect(compareDecimal('100.19', '100.2')).toBe(-1);
    expect(compareDecimal('3450.00', '3450')).toBe(0);
    expect(compareDecimal('0.30000000000000004', '0.3')).toBe(1);
    expect(compareDecimal('1000000000000000000', '999999999999999999')).toBe(1);
    expect(compareDecimal('007.50', '7.5')).toBe(0);
  });
});

describe('limitSatisfied (directional — SELL floor, BUY ceiling)', () => {
  it('SELL: accept iff best >= limit (limit is a floor)', () => {
    expect(limitSatisfied('3500', '3400', 'SELL')).toBe(true);
    expect(limitSatisfied('3400', '3400', 'SELL')).toBe(true);
    expect(limitSatisfied('3399.99', '3400', 'SELL')).toBe(false);
  });
  it('BUY: accept iff best <= limit (limit is a ceiling)', () => {
    expect(limitSatisfied('3400', '3500', 'BUY')).toBe(true);
    expect(limitSatisfied('3500', '3500', 'BUY')).toBe(true);
    expect(limitSatisfied('3500.01', '3500', 'BUY')).toBe(false);
  });
});

import { selectBestBid } from '../lib/swap.js';

const q = (over: Partial<import('../lib/swap.js').SwapQuote>): import('../lib/swap.js').SwapQuote => ({
  id: 'q', rfqId: 'r', marketMakerId: 'mm', price: '100', amount: '10',
  status: 'PENDING', ...over,
});

describe('selectBestBid', () => {
  it('SELL picks the HIGHEST price among eligible', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '3400' }), q({ id: 'b', price: '3500' }), q({ id: 'c', price: '3450' })],
      'SELL', '10');
    expect(best?.id).toBe('b');
  });
  it('BUY picks the LOWEST price among eligible', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '3400' }), q({ id: 'b', price: '3500' }), q({ id: 'c', price: '3350' })],
      'BUY', '10');
    expect(best?.id).toBe('c');
  });
  it('excludes non-PENDING quotes', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '9999', status: 'EXPIRED' }), q({ id: 'b', price: '3400', status: 'PENDING' })],
      'SELL', '10');
    expect(best?.id).toBe('b');
  });
  it('excludes quotes that do not cover the requested amount (full-fill v1)', () => {
    const best = selectBestBid(
      [q({ id: 'a', price: '9999', amount: '5' }), q({ id: 'b', price: '3400', amount: '10' })],
      'SELL', '10');
    expect(best?.id).toBe('b');
  });
  it('accepts a quote whose amount exceeds the request', () => {
    const best = selectBestBid([q({ id: 'a', price: '3400', amount: '50' })], 'SELL', '10');
    expect(best?.id).toBe('a');
  });
  it('returns null when no eligible quote', () => {
    expect(selectBestBid([], 'SELL', '10')).toBeNull();
    expect(selectBestBid([q({ status: 'REJECTED' })], 'SELL', '10')).toBeNull();
    expect(selectBestBid([q({ amount: '1' })], 'SELL', '10')).toBeNull();
  });
});

import { pollForQuotes, type SwapClient, runSwapQuote } from '../lib/swap.js';
import type { Remember } from '../lib/swap.js';

function fakeClient(over: Partial<SwapClient>): SwapClient {
  return {
    createRFQ: async () => ({ id: 'r1', status: 'ACTIVE' }),
    getRFQ: async () => ({ id: 'r1', side: 'SELL', amount: '10', status: 'ACTIVE' }),
    getQuotes: async () => [],
    acceptQuote: async () => ({ id: 'q', rfqId: 'r1', status: 'ACCEPTED', trade: { id: 't1', status: 'PROPOSED' } }),
    cancelRFQ: async () => ({ id: 'r1', status: 'CANCELLED' }),
    ...over,
  };
}
const noSleep = async () => {};

describe('pollForQuotes', () => {
  it('early-returns as soon as an eligible bid exists', async () => {
    let calls = 0;
    const client = fakeClient({
      getQuotes: async () => {
        calls += 1;
        return calls < 2 ? [] : [{ id: 'q1', rfqId: 'r1', marketMakerId: 'mm', price: '3400', amount: '10', status: 'PENDING' }];
      },
    });
    const quotes = await pollForQuotes(client, 'r1', 'SELL', '10', 20, noSleep);
    expect(quotes).toHaveLength(1);
    expect(calls).toBe(2);
  });
  it('stops after the bounded window when no eligible bid arrives', async () => {
    let calls = 0;
    const client = fakeClient({ getQuotes: async () => { calls += 1; return []; } });
    const quotes = await pollForQuotes(client, 'r1', 'SELL', '10', 20, noSleep);
    expect(quotes).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  it('caps wait at 25s (negative/huge inputs clamped)', async () => {
    let calls = 0;
    const client = fakeClient({ getQuotes: async () => { calls += 1; return []; } });
    await pollForQuotes(client, 'r1', 'SELL', '10', 9999, noSleep);
    const capped = await (async () => calls)();
    expect(calls).toBeLessThanOrEqual(11);
  });
});

const passthrough: Remember = (op) => op();

function parse(content: { content: { text: string }[] }) {
  return JSON.parse(content.content[0].text);
}

describe('runSwapQuote', () => {
  it('opens RFQ with isBlind defaulting true and returns a QUOTED handle when a bid arrives', async () => {
    let createInput: any;
    const client = fakeClient({
      createRFQ: async (i: unknown) => { createInput = i; return { id: 'rfq-9', status: 'ACTIVE' }; },
      getQuotes: async () => [{ id: 'q1', rfqId: 'rfq-9', marketMakerId: 'mm', price: '3500', amount: '2', status: 'PENDING' }],
    });
    const out = parse(await runSwapQuote(client, {
      side: 'SELL', baseToken: 'ETH', quoteToken: 'USDT', amount: '2', limit_price: '3400',
    }, { sleep: noSleep, remember: passthrough }));

    expect(createInput.isBlind).toBe(true);
    expect('limit_price' in createInput).toBe(false);
    expect(out.swap_handle).toBe('rfq-9');
    expect(out.status).toBe('QUOTED');
    expect(out.best_bid.quote_id).toBe('q1');
    expect(out.best_bid.price).toBe('3500');
    expect(out.bids_seen).toBe(1);
    expect(out.limit_price).toBe('3400');
  });

  it('returns an OPEN handle with null best_bid when no bid arrives in the window', async () => {
    const client = fakeClient({ createRFQ: async () => ({ id: 'rfq-x', status: 'ACTIVE' }), getQuotes: async () => [] });
    const out = parse(await runSwapQuote(client, { side: 'BUY', baseToken: 'ETH', quoteToken: 'USDT', amount: '1' },
      { sleep: noSleep, remember: passthrough }));
    expect(out.status).toBe('OPEN');
    expect(out.best_bid).toBeNull();
    expect(out.still_open).toBe(true);
  });

  it('honors private:false override', async () => {
    let createInput: any;
    const client = fakeClient({ createRFQ: async (i: unknown) => { createInput = i; return { id: 'r', status: 'ACTIVE' }; }, getQuotes: async () => [] });
    await runSwapQuote(client, { side: 'SELL', baseToken: 'ETH', quoteToken: 'USDT', amount: '1', private: false },
      { sleep: noSleep, remember: passthrough });
    expect(createInput.isBlind).toBe(false);
  });
});

import { runSwapExecute } from '../lib/swap.js';

const SELL_RFQ = { id: 'r1', side: 'SELL' as const, amount: '10', status: 'QUOTES_RECEIVED' };
const pendingBids = [
  { id: 'qa', rfqId: 'r1', marketMakerId: 'mm', price: '3400', amount: '10', status: 'PENDING' },
  { id: 'qb', rfqId: 'r1', marketMakerId: 'mm', price: '3500', amount: '10', status: 'PENDING' },
];

describe('runSwapExecute', () => {
  it('CONFIRMATION_REQUIRED when neither quote_id nor limit_price given', async () => {
    const client = fakeClient({ getRFQ: async () => SELL_RFQ, getQuotes: async () => pendingBids });
    const out = parse(await runSwapExecute(client, { swap_handle: 'r1' }, passthrough));
    expect(out.outcome).toBe('CONFIRMATION_REQUIRED');
  });
  it('accepts the best bid when the sealed limit is satisfied (SELL floor)', async () => {
    let accepted: string | undefined;
    const client = fakeClient({
      getRFQ: async () => SELL_RFQ, getQuotes: async () => pendingBids,
      acceptQuote: async (id: string) => { accepted = id; return { id, rfqId: 'r1', status: 'ACCEPTED', trade: { id: 't9', status: 'PROPOSED' } }; },
    });
    const out = parse(await runSwapExecute(client, { swap_handle: 'r1', limit_price: '3450' }, passthrough));
    expect(accepted).toBe('qb');
    expect(out.trade_id).toBe('t9');
    expect(out.accepted_price).toBe('3500');
    expect(out.accepted_amount).toBe('10');
  });
  it('NO_ACCEPTABLE_FILL when best bid misses the SELL floor', async () => {
    const client = fakeClient({ getRFQ: async () => SELL_RFQ, getQuotes: async () => pendingBids });
    const out = parse(await runSwapExecute(client, { swap_handle: 'r1', limit_price: '9999' }, passthrough));
    expect(out.outcome).toBe('NO_ACCEPTABLE_FILL');
    expect(out.best_price).toBe('3500');
  });
  it('explicit quote_id path accepts exactly that quote', async () => {
    let accepted: string | undefined;
    const client = fakeClient({
      getRFQ: async () => SELL_RFQ, getQuotes: async () => pendingBids,
      acceptQuote: async (id: string) => { accepted = id; return { id, rfqId: 'r1', status: 'ACCEPTED', trade: { id: 't1', status: 'PROPOSED' } }; },
    });
    await runSwapExecute(client, { swap_handle: 'r1', quote_id: 'qa' }, passthrough);
    expect(accepted).toBe('qa');
  });
  it('QUOTE_NOT_AVAILABLE when the given quote_id is not an eligible bid', async () => {
    const client = fakeClient({ getRFQ: async () => SELL_RFQ, getQuotes: async () => pendingBids });
    const out = parse(await runSwapExecute(client, { swap_handle: 'r1', quote_id: 'ghost' }, passthrough));
    expect(out.outcome).toBe('QUOTE_NOT_AVAILABLE');
  });
  it('SWAP_NOT_OPEN when the RFQ is in a terminal state', async () => {
    const client = fakeClient({ getRFQ: async () => ({ ...SELL_RFQ, status: 'CANCELLED' }) });
    const out = parse(await runSwapExecute(client, { swap_handle: 'r1', limit_price: '1' }, passthrough));
    expect(out.outcome).toBe('SWAP_NOT_OPEN');
    expect(out.rfq_status).toBe('CANCELLED');
  });
  it('SWAP_NOT_FOUND when the handle is unknown', async () => {
    const client = fakeClient({ getRFQ: async () => null });
    const out = parse(await runSwapExecute(client, { swap_handle: 'nope', limit_price: '1' }, passthrough));
    expect(out.outcome).toBe('SWAP_NOT_FOUND');
  });
});
