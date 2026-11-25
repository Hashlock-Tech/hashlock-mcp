import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Asset, Rfq, Thread } from '../client.js';
import { createHttpApp } from '../http/server.js';
import { registerTools } from '../tools.js';

// The confirm gate (lib/confirm.ts) through the real servers and the SDK's own client. Each case counts the writes the
// API received: the point is whether a price was committed, not what the client was shown.
const RFQ = '3f2a1b2c-1111-4111-8111-111111111111';
const SWAP = '5e5e5e5e-2222-4222-8222-222222222222';
const USDC = { id: 'a-usdc', symbol: 'USDC', chain: 'ethereum', decimals: 6, name: null, address: '0x' + '1'.repeat(40), enabled: true } satisfies Asset;
const BTC = { id: 'a-btc', symbol: 'BTC', chain: 'bitcoin', decimals: 8, name: null, address: null, isNative: true, enabled: true } satisfies Asset;
// The requester sells 0.5 BTC; a maker quotes 30,000 USDC for it. Bitcoin is the long leg, so the requester initiates.
const rfq: Rfq = {
  id: RFQ, creatorId: 'u-taker', direction: 'sell_base', baseAssetId: BTC.id, baseAmount: '50000000', quoteAssetId: USDC.id,
  askAmount: null, visibility: 'public', targetAddress: null, status: 'open', expiresAt: '2026-12-01T00:00:00Z', createdAt: '2026-11-25T00:00:00Z',
};
const thread: Thread = {
  id: RFQ, rfqId: RFQ, makerId: 'u-maker', takerId: 'u-taker', status: 'open', currentQuoteAmount: '30000000000', pendingAmount: null,
  pendingBy: null, takerAccepted: false, makerAccepted: true, hashlock: null,
};
const QUOTE = { id: RFQ, quoteAmount: '30000000000' };
const SAYS = 'Quote request 3f2a1b2c…: you give 30,000 USDC on Ethereum and receive 0.5 BTC on Bitcoin. This binds you to this price: if the requester accepts, the deal is agreed.';
// The requester's side at 10 bps: 0.1% of the 0.5 BTC it gives.
const TAKER_TERMS = 'you give 0.5 BTC on Bitcoin, plus a protocol fee of 0.0005 BTC (0.1%) that is not refunded, and receive 30,000 USDC on Ethereum';
const CONFIG = { fee: { bps: 10, payer: 'taker' }, chains: { bitcoin: { family: 'bitcoin', timelockSeconds: 86400 }, ethereum: { family: 'evm', timelockSeconds: 14400 } } };
const TARGET = '0x' + '3'.repeat(40);
const SWAP_ROW = { id: SWAP, threadId: RFQ, makerId: 'u-maker', takerId: 'u-taker', aChain: 'ethereum', bChain: 'bitcoin' };

// ── a /v1 (and the /api/config beside it) that answers the reads and counts the writes ─────────────────────────────
let v1: Server;
let v1Url: string;
const writes: string[] = [];
let assetsStatus = 200;
let configStatus = 200;
let listed: Asset[] = [USDC, BTC];
let meId = 'u-maker';
let rfqNow: Rfq = rfq;
beforeAll(async () => {
  v1 = createServer((req, res) => {
    const json = (status: number, body: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = req.url!.replace(/^\/v1/, '');
    if (req.method === 'POST') {
      writes.push(path);
      return json(201, { thread: { ...thread, dealUrl: `https://hashlock.test/deals/${RFQ}` } });
    }
    if (path === '/api/config') return configStatus === 200 ? json(200, CONFIG) : json(configStatus, { error: 'down' });
    if (path === '/assets') return assetsStatus === 200 ? json(200, { assets: listed }) : json(assetsStatus, { error: 'registry down' });
    if (path === `/rfqs/${RFQ}`) return json(200, { rfq: rfqNow });
    if (path === `/threads/${RFQ}`) return json(200, { thread, rfq: rfqNow, messages: [], swap: null });
    if (path === `/swaps/${SWAP}`) return json(200, { swap: SWAP_ROW });
    if (path === '/me') return json(200, { userId: meId, scopes: ['maker', 'taker'] });
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => v1.listen(0, '127.0.0.1', r));
  v1Url = `http://127.0.0.1:${(v1.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  v1.closeAllConnections();
  v1.close();
});

const clients: Client[] = [];
afterEach(async () => {
  writes.length = 0;
  assetsStatus = 200;
  configStatus = 200;
  listed = [USDC, BTC];
  meId = 'u-maker';
  rfqNow = rfq;
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
/** A client that answers every form with `answer` (when given) and records the messages it was shown. */
function makeClient(options: ConstructorParameters<typeof Client>[1], answer?: Answer) {
  const asked: string[] = [];
  const client = new Client({ name: 'test', version: '0' }, options);
  if (answer) {
    client.setRequestHandler('elicitation/create', async (req) => {
      asked.push((req.params as { message: string }).message);
      return answer;
    });
  }
  clients.push(client);
  return { client, asked };
}
const FORM = { elicitation: { form: {} } };
const ACCEPT: Answer = { action: 'accept', content: { confirm: true } };
const DECLINE: Answer = { action: 'decline' };

/** `key`: hk_oa_ is a chat assistant's (OAuth) key, hk_ a developer's. */
async function hosted(options: ConstructorParameters<typeof Client>[1], answer?: Answer, key = 'hk_oa_test') {
  const app = createHttpApp({ v1Url });
  const c = makeClient(options, answer);
  await c.client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      fetch: (url, init) => app.request(String(url), init),
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return c;
}
const modern = (capabilities: object, answer?: Answer, key?: string) => hosted({ versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities }, answer, key);
const developer = (answer: Answer) => modern(FORM, answer, 'hk_test');

describe('hosted: confirm before committing to a price', () => {
  it('a 2026-07-28 client that confirms: shown the terms read from the API, and the quote is sent once', async () => {
    const { client, asked } = await modern(FORM, ACCEPT);
    const r = await client.callTool({ name: 'quote_rfq', arguments: QUOTE });
    expect(r.isError).toBeFalsy();
    expect(asked).toEqual([SAYS]);
    expect(writes).toEqual([`/rfqs/${RFQ}/quotes`]);
  });

  it.each(['decline', 'cancel'] as const)('a 2026-07-28 client that answers %s: nothing is sent, and the result says so without an error', async (action) => {
    const { client, asked } = await modern(FORM, { action });
    const r = await client.callTool({ name: 'quote_rfq', arguments: QUOTE });
    expect(asked).toHaveLength(1);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ declined: true });
    expect(writes).toEqual([]);
  });

  it.each([{ confirm: false }, {}, { confirm: 'yes' }])('an accept whose content is %j is a decline: asked once, nothing sent', async (content) => {
    const { client, asked } = await modern(FORM, { action: 'accept', content });
    expect((await client.callTool({ name: 'quote_rfq', arguments: QUOTE })).structuredContent).toMatchObject({ declined: true });
    expect(asked).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('terms that cannot be read: an error, and nothing is sent', async () => {
    assetsStatus = 503;
    const { client, asked } = await modern(FORM, ACCEPT);
    const r = await client.callTool({ name: 'quote_rfq', arguments: QUOTE });
    expect(r.isError).toBe(true);
    expect(asked).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('a client that cannot show a form is not asked: the quote is sent as before', async () => {
    const { client } = await modern({});
    expect((await client.callTool({ name: 'quote_rfq', arguments: QUOTE })).isError).toBeFalsy();
    expect(writes).toEqual([`/rfqs/${RFQ}/quotes`]);
  });

  it('a 2025-era client is never asked, though it declared elicitation: no hang, and the quote is sent as before', async () => {
    const { client, asked } = await hosted({ capabilities: FORM }, ACCEPT);
    expect(client.getProtocolEra()).toBe('legacy');
    const r = await client.callTool({ name: 'quote_rfq', arguments: QUOTE }, { timeout: 5_000 });
    expect(r.isError).toBeFalsy();
    expect(asked).toEqual([]);
    expect(writes).toEqual([`/rfqs/${RFQ}/quotes`]);
  });

  it("states the caller's own side of a thread, read from the API", async () => {
    const { client, asked } = await modern(FORM, ACCEPT);
    await client.callTool({ name: 'accept_terms', arguments: QUOTE });
    expect(asked).toEqual([
      'Accept deal 3f2a1b2c…: you give 30,000 USDC on Ethereum and receive 0.5 BTC on Bitcoin. This agrees the deal at this price; once both sides have accepted, each funds its leg.',
    ]);
    expect(writes).toEqual([`/threads/${RFQ}/accept`]);
  });

  it('an asset closed after the thread opened is named by its id and base units, and the person is still asked', async () => {
    listed = [USDC]; // /v1/assets lists open assets only
    const { client, asked } = await developer(DECLINE);
    await client.callTool({ name: 'quote_rfq', arguments: QUOTE });
    expect(asked).toEqual([
      'Quote request 3f2a1b2c…: you give 30,000 USDC on Ethereum and receive 50000000 base units of asset a-btc…, which is not open for trading. This binds you to this price: if the requester accepts, the deal is agreed.',
    ]);
  });
});

describe('hosted: the requester confirms the protocol fee it pays', () => {
  it('accepting: the fee on the leg it gives, at the rate /api/config states', async () => {
    meId = 'u-taker';
    const { client, asked } = await developer(DECLINE);
    await client.callTool({ name: 'accept_terms', arguments: QUOTE });
    expect(asked).toEqual([`Accept deal 3f2a1b2c…: ${TAKER_TERMS}. This agrees the deal at this price; once both sides have accepted, each funds its leg.`]);
    expect(writes).toEqual([]);
  });

  it.each([
    [
      'a private order',
      { direction: 'sell_base', baseAmount: '50000000', visibility: 'private', askAmount: '30000000000' },
      `Post a private order: ${TAKER_TERMS}. Nothing binds you until you accept a quote.`,
    ],
    [
      'a public buy, whose price is agreed later',
      { direction: 'buy_base', baseAmount: '50000000' },
      'Post a request: you give USDC on Ethereum at a price agreed later, plus a protocol fee of 0.1% of that price that is not refunded, and receive 0.5 BTC on Bitcoin. Nothing binds you until you accept a quote.',
    ],
    [
      'a private order reserved for one wallet, named in full',
      { direction: 'sell_base', baseAmount: '50000000', visibility: 'private', askAmount: '30000000000', targetAddress: TARGET },
      `Post a private order, reserved for ${TARGET}: ${TAKER_TERMS}. Nothing binds you until you accept a quote.`,
    ],
    [
      'a public request with a target, which the API drops',
      { direction: 'buy_base', baseAmount: '50000000', targetAddress: TARGET },
      'Post a request: you give USDC on Ethereum at a price agreed later, plus a protocol fee of 0.1% of that price that is not refunded, and receive 0.5 BTC on Bitcoin. Nothing binds you until you accept a quote.',
    ],
    [
      'a Bitcoin fee below the dust limit, which the API waives',
      { direction: 'sell_base', baseAmount: '100000' },
      'Post a request: you give 0.001 BTC on Bitcoin, with no protocol fee, and receive USDC on Ethereum at a price agreed later. Nothing binds you until you accept a quote.',
    ],
  ])('posting %s', async (_, a, says) => {
    const { client, asked } = await developer(DECLINE);
    await client.callTool({ name: 'create_rfq', arguments: { baseAssetId: BTC.id, quoteAssetId: USDC.id, ttlSeconds: 3600, ...a } });
    expect(asked).toEqual([says]);
    expect(writes).toEqual([]);
  });

  it('a fee that cannot be read: an error, nothing asked and nothing sent', async () => {
    meId = 'u-taker';
    configStatus = 503;
    const { client, asked } = await developer(ACCEPT);
    const r = await client.callTool({ name: 'accept_terms', arguments: QUOTE });
    expect(r.isError).toBe(true);
    expect(asked).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("hosted: an initiator on a chat assistant's key agrees only on the deal page", () => {
  it.each([
    ['accept_terms', QUOTE, `/threads/${RFQ}/accept`],
    ['accept_proposal', { ...QUOTE, accept: true }, `/threads/${RFQ}/accept-proposal`],
  ])('%s is not asked: the API decides, and refuses it without a hashlock', async (name, args, path) => {
    meId = 'u-taker';
    const { client, asked } = await modern(FORM, ACCEPT);
    await client.callTool({ name, arguments: args });
    expect(asked).toEqual([]);
    expect(writes).toEqual([path]);
  });

  it('a counter says it does not bind them; on a developer key it binds, as before', async () => {
    meId = 'u-taker';
    const chat = await modern(FORM, DECLINE);
    await chat.client.callTool({ name: 'propose_price', arguments: QUOTE });
    expect(chat.asked).toEqual([
      `Counter on deal 3f2a1b2c…: ${TAKER_TERMS}. As the initiator you are not bound by this counter: you agree only when you accept the deal on its page.`,
    ]);
    const dev = await developer(DECLINE);
    await dev.client.callTool({ name: 'propose_price', arguments: QUOTE });
    expect(dev.asked).toEqual([`Counter on deal 3f2a1b2c…: ${TAKER_TERMS}. This binds you to this price: if the counterparty takes it, the deal is agreed.`]);
    expect(writes).toEqual([]);
  });

  it('a maker that gives Bitcoin is the initiator: its quote does not bind it', async () => {
    rfqNow = { ...rfq, direction: 'buy_base' };
    const { client, asked } = await modern(FORM, DECLINE);
    await client.callTool({ name: 'quote_rfq', arguments: QUOTE });
    expect(asked).toEqual([
      'Quote request 3f2a1b2c…: you give 0.5 BTC on Bitcoin and receive 30,000 USDC on Ethereum. As the initiator you are not bound by this quote: you agree only when you accept the deal on its page.',
    ]);
  });
});

describe('hosted: a payout address is confirmed', () => {
  it.each([
    ['bitcoin', 'bc1qexampleexampleexampleexampleexample00', 'Payouts for swap 5e5e5e5e… on Bitcoin go to bc1qexampleexampleexampleexampleexample00.'],
    ['ethereum', '0x' + '2'.repeat(40), `Your leg of swap 5e5e5e5e… on Ethereum is funded from 0x${'2'.repeat(40)}, and a refund goes back to it.`],
  ])('on %s: says what the address is for, and a decline sets nothing', async (chain, address, says) => {
    const { client, asked } = await modern(FORM, DECLINE);
    expect((await client.callTool({ name: 'set_swap_address', arguments: { id: SWAP, chain, address } })).structuredContent).toMatchObject({ declined: true });
    expect(asked).toEqual([says]);
    expect(writes).toEqual([]);
  });

  it("a Bitcoin refund given an address is refused before the person is asked, as the API refuses it; a key is asked", async () => {
    meId = 'u-taker'; // the taker funds leg b, on Bitcoin: this column is its refund
    const { client, asked } = await modern(FORM, DECLINE);
    const r = await client.callTool({ name: 'set_swap_address', arguments: { id: SWAP, chain: 'bitcoin', address: 'bc1qexampleexampleexampleexampleexample00' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("a Bitcoin refund is set by your wallet's key");
    expect(asked).toEqual([]);
    const key = '02' + 'a'.repeat(64);
    await client.callTool({ name: 'set_swap_address', arguments: { id: SWAP, chain: 'bitcoin', address: key } });
    expect(asked).toEqual([`Refunds of your leg of swap 5e5e5e5e… on Bitcoin go to the wallet of key ${key}.`]);
    expect(writes).toEqual([]);
  });

  it('confirmed, the address is sent', async () => {
    const { client } = await modern(FORM, ACCEPT);
    await client.callTool({ name: 'set_swap_address', arguments: { id: SWAP, chain: 'bitcoin', address: '02' + 'a'.repeat(64) } });
    expect(writes).toEqual([`/swaps/${SWAP}/address`]);
  });
});

describe('stdio: the SDK shim asks a 2025-era client over the connection', () => {
  const sent: string[] = [];
  const agreed = new Set<string>();
  let me = 'u-maker';
  const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  // The taker funds leg b, 0.5 BTC, and owes the 0.0005 BTC fee on it (10 bps).
  const swap = {
    id: RFQ, rfqId: RFQ, threadId: RFQ, makerId: 'u-maker', takerId: 'u-taker', initiatorUserId: 'u-taker', hashlock: 'aa'.repeat(32),
    aAssetId: USDC.id, aChain: 'ethereum', aAmount: '30000000000', aTimelock: later(4), bAssetId: BTC.id, bChain: 'bitcoin', bAmount: '50000000', bTimelock: later(24),
    feeAssetId: BTC.id, feeAmount: '50000',
  };
  const FUND_SAYS = "Fund your leg of swap 3f2a1b2c…: this agent's wallet sends 0.5 BTC on Bitcoin into the escrow, and a protocol fee of 0.0005 BTC on Bitcoin, paid at funding and not refunded. You receive 30,000 USDC on Ethereum when the swap settles. Once sent, the escrowed amount comes back only by refund after the timelock.";
  const snapshot = (a: Asset) => ({ id: a.id, symbol: a.symbol, chain: a.chain, address: a.address, isNative: a.isNative === true });
  const agreement = { side: 'taker', direction: 'sell_base', base: snapshot(BTC), quote: snapshot(USDC), baseAmount: '50000000', prices: { [RFQ]: ['30000000000'] } };
  let registry: Asset[] = [USDC, BTC];
  const api = {
    assets: async () => registry,
    resolveAsset: async (ref: string) => registry.find((a) => a.id === ref)!,
    familyOf: async (chain: string) => (chain === 'bitcoin' ? 'btc' : 'evm'),
    feeBps: async () => 10,
    getRfq: async () => ({ rfq }),
    getThread: async () => ({ thread, rfq }),
    getSwap: async () => ({ swap }),
    postQuote: async (id: string) => {
      sent.push(`quote ${id}`);
      return { quote: {}, thread };
    },
    postMessage: async (id: string) => void sent.push(`message ${id}`),
    accept: async (id: string) => void sent.push(`accept ${id}`),
    setSwapAddress: async (id: string) => void sent.push(`address ${id}`),
    me: async () => ({ user: { id: me } }),
  };
  const agreements = { agree: () => {}, get: (id: string) => (agreed.has(id) ? agreement : null) };
  afterEach(() => {
    agreed.clear();
    me = 'u-maker';
    registry = [USDC, BTC];
  });
  async function stdio(answer: Answer, capabilities: object = FORM) {
    sent.length = 0;
    const server = new McpServer({ name: 't', version: '0' });
    registerTools(server, api as never, {} as never, agreements as never);
    const c = makeClient({ capabilities }, answer);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), c.client.connect(b)]);
    return c;
  }

  it('asks, and quotes once the person confirms', async () => {
    const { client, asked } = await stdio(ACCEPT);
    expect(client.getProtocolEra()).toBe('legacy');
    const r = await client.callTool({ name: 'respond_to_rfq', arguments: { rfq_id: RFQ, price: '30000' } });
    expect(r.isError).toBeFalsy();
    expect(asked).toEqual([SAYS]);
    expect(sent).toEqual([`quote ${RFQ}`]);
  });

  it('quotes nothing when the person declines', async () => {
    const { client } = await stdio(DECLINE);
    expect((await client.callTool({ name: 'respond_to_rfq', arguments: { rfq_id: RFQ, price: '30000' } })).structuredContent).toMatchObject({ declined: true });
    expect(sent).toEqual([]);
  });

  it("negotiate on a deal not made through this MCP is refused before the person is asked", async () => {
    const { client, asked } = await stdio(ACCEPT);
    const r = await client.callTool({ name: 'negotiate', arguments: { thread_id: RFQ, action: 'accept', price: '30000' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('was not created or quoted through this MCP');
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('negotiate as the requester states the fee it pays', async () => {
    agreed.add(RFQ);
    me = 'u-taker';
    const { client, asked } = await stdio(DECLINE);
    await client.callTool({ name: 'negotiate', arguments: { thread_id: RFQ, action: 'accept', price: '30000' } });
    expect(asked).toEqual([`Accept deal 3f2a1b2c…: ${TAKER_TERMS}. This agrees the deal at this price; once both sides have accepted, each funds its leg.`]);
    expect(sent).toEqual([]);
  });

  it('fund_leg asks with the swap as the API holds it, and a decline signs nothing', async () => {
    agreed.add(RFQ);
    me = 'u-taker';
    const { client, asked } = await stdio(DECLINE);
    // Past the gate fund_leg would need keys and chains this stub has none of: a decline must never get there.
    expect((await client.callTool({ name: 'fund_leg', arguments: { swap_id: RFQ } })).structuredContent).toMatchObject({ declined: true });
    expect(asked).toEqual([FUND_SAYS]);
  });

  it('fund_leg names an asset that has left the registry from the agreement, which fundMyLeg funds from', async () => {
    agreed.add(RFQ);
    me = 'u-taker';
    registry = [USDC]; // BTC delisted after the deal was agreed
    const { client, asked } = await stdio(DECLINE);
    expect((await client.callTool({ name: 'fund_leg', arguments: { swap_id: RFQ } })).structuredContent).toMatchObject({ declined: true });
    expect(asked).toEqual([FUND_SAYS]);
  });

  it('create_rfq names the wallet a private order is reserved for, in full', async () => {
    me = 'u-taker';
    const { client, asked } = await stdio(DECLINE);
    await client.callTool({
      name: 'create_rfq',
      arguments: { direction: 'sell_base', base_asset: BTC.id, base_amount: '0.5', quote_asset: USDC.id, ask_price: '30000', visibility: 'private', target_address: TARGET, ttl_seconds: 3600 },
    });
    expect(asked).toEqual([`Post a private order, reserved for ${TARGET}: ${TAKER_TERMS}. Nothing binds you until you accept a quote.`]);
    expect(sent).toEqual([]);
  });

  it('fund_leg on a deal not agreed through this MCP is refused before the person is asked', async () => {
    me = 'u-taker';
    const { client, asked } = await stdio(ACCEPT);
    const r = await client.callTool({ name: 'fund_leg', arguments: { swap_id: RFQ } });
    expect(r.isError).toBe(true);
    expect(asked).toEqual([]);
  });

  it('set_settlement_address names the chain and the full address, and a decline sets nothing', async () => {
    const { client, asked } = await stdio(DECLINE);
    const key = '03' + 'b'.repeat(64);
    expect((await client.callTool({ name: 'set_settlement_address', arguments: { swap_id: RFQ, chain: 'bitcoin', address: key } })).structuredContent).toMatchObject({ declined: true });
    expect(asked).toEqual([`Payouts for swap 3f2a1b2c… on Bitcoin go to the wallet of key ${key}.`]);
    expect(sent).toEqual([]);
  });

  it('does not ask for a chat message, which commits to nothing', async () => {
    const { client, asked } = await stdio(ACCEPT);
    await client.callTool({ name: 'negotiate', arguments: { thread_id: RFQ, action: 'message', body: 'hi' } });
    expect(asked).toEqual([]);
    expect(sent).toEqual([`message ${RFQ}`]);
  });
});
