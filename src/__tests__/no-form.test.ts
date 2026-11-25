import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Asset, Rfq, Thread } from '../client.js';
import { createHttpApp } from '../http/server.js';
import { registerTools } from '../tools.js';

// No tool asks the person to confirm: a client that can show a form is never shown one, and each write goes straight
// to the API, once.
const ID = '3f2a1b2c-1111-4111-8111-111111111111';
const FORM = { elicitation: { form: {}, url: {} } };

/** A client that records every elicitation it is sent, and accepts it. */
function recording(options: ConstructorParameters<typeof Client>[1]) {
  const asked: unknown[] = [];
  const client = new Client({ name: 'test', version: '0' }, options);
  client.setRequestHandler('elicitation/create', async (req) => {
    asked.push(req.params);
    return { action: 'accept', content: { confirm: true } };
  });
  return { client, asked };
}

describe('hosted: a form-capable 2026-07-28 client is never asked', () => {
  const requests: string[] = [];
  let v1: Server;
  let v1Url: string;
  beforeAll(async () => {
    v1 = createServer((req, res) => {
      requests.push(`${req.method} ${req.url!.replace(/^\/v1/, '')}`);
      res.writeHead(req.method === 'POST' ? 201 : 404, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => v1.listen(0, '127.0.0.1', r));
    v1Url = `http://127.0.0.1:${(v1.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => {
    v1.closeAllConnections();
    v1.close();
  });

  const writes: [string, Record<string, unknown>, string][] = [
    ['create_rfq', { direction: 'sell_base', baseAssetId: 'a-btc', baseAmount: '50000000', quoteAssetId: 'a-usdc', ttlSeconds: 3600 }, 'POST /rfqs'],
    ['accept_terms', { id: ID, quoteAmount: '30000000000' }, `POST /threads/${ID}/accept`],
    ['set_swap_address', { id: ID, chain: 'ethereum', address: '0x' + '3'.repeat(40) }, `POST /swaps/${ID}/address`],
  ];
  it.each(['hk_test', 'hk_oa_test'])('%s: each write reaches /v1 once, with nothing read or asked first', async (key) => {
    const { client, asked } = recording({ versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: FORM });
    const app = createHttpApp({ v1Url });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
        fetch: (url, init) => app.request(String(url), init),
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    try {
      for (const [name, args, route] of writes) {
        requests.length = 0;
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError, name).toBeFalsy();
        expect(requests, name).toEqual([route]);
      }
      expect(asked).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('stdio: a form-capable client is never asked', () => {
  const USDC = { id: 'a-usdc', symbol: 'USDC', chain: 'ethereum', decimals: 6, name: null, address: '0x' + '1'.repeat(40), enabled: true } satisfies Asset;
  const BTC = { id: 'a-btc', symbol: 'BTC', chain: 'bitcoin', decimals: 8, name: null, address: null, isNative: true, enabled: true } satisfies Asset;
  const rfq: Rfq = {
    id: ID, creatorId: 'u-taker', direction: 'sell_base', baseAssetId: BTC.id, baseAmount: '50000000', quoteAssetId: USDC.id,
    askAmount: null, visibility: 'public', targetAddress: null, status: 'open', expiresAt: '2026-12-01T00:00:00Z', createdAt: '2026-11-25T00:00:00Z',
  };
  const thread: Thread = {
    id: ID, rfqId: ID, makerId: 'u-maker', takerId: 'u-taker', status: 'open', currentQuoteAmount: '30000000000', pendingAmount: null,
    pendingBy: null, takerAccepted: false, makerAccepted: true, hashlock: null,
  };
  // An agreed deal: the taker funds leg b, 0.5 BTC, and owes the 0.0005 BTC fee on it.
  const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const swap = {
    id: ID, rfqId: ID, threadId: ID, makerId: 'u-maker', takerId: 'u-taker', initiatorUserId: 'u-taker', hashlock: 'aa'.repeat(32),
    aAssetId: USDC.id, aChain: 'ethereum', aAmount: '30000000000', aTimelock: later(4), bAssetId: BTC.id, bChain: 'bitcoin', bAmount: '50000000', bTimelock: later(24),
    feeAssetId: BTC.id, feeAmount: '50000',
  };
  const snapshot = (a: Asset) => ({ id: a.id, symbol: a.symbol, chain: a.chain, address: a.address, isNative: a.isNative === true });
  const agreement = { side: 'taker', direction: 'sell_base', base: snapshot(BTC), quote: snapshot(USDC), baseAmount: '50000000', prices: { [ID]: ['30000000000'] } };
  const quotes: string[] = [];
  const api = {
    assets: async () => [USDC, BTC],
    familyOf: async (chain: string) => (chain === 'bitcoin' ? 'btc' : 'evm'),
    me: async () => ({ user: { id: 'u-taker' } }),
    getRfq: async () => ({ rfq }),
    getSwap: async () => ({ swap }),
    postQuote: async (id: string, amount: string) => {
      quotes.push(`${id} ${amount}`);
      return { quote: {}, thread };
    },
  };
  let agreed: typeof agreement | null = null;
  const agreements = { agree: () => {}, get: () => agreed };

  async function stdio() {
    const server = new McpServer({ name: 't', version: '0' });
    registerTools(server, api as never, {} as never, agreements as never);
    const c = recording({ capabilities: FORM });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), c.client.connect(b)]);
    return c;
  }

  it('respond_to_rfq quotes once', async () => {
    const { client, asked } = await stdio();
    const r = await client.callTool({ name: 'respond_to_rfq', arguments: { rfq_id: ID, price: '30000' } });
    expect(r.isError).toBeFalsy();
    expect(quotes).toEqual([`${ID} 30000000000`]);
    expect(asked).toEqual([]);
    await client.close();
  });

  it('fund_leg on an agreed deal goes straight to funding', async () => {
    agreed = agreement;
    const { client, asked } = await stdio();
    // Past the deal check, funding stops on this stub's swap, which has no addresses: nobody was asked on the way.
    const r = await client.callTool({ name: 'fund_leg', arguments: { swap_id: ID } });
    expect(JSON.stringify(r.content)).not.toContain('no record of agreeing');
    expect(asked).toEqual([]);
    await client.close();
  });
});
