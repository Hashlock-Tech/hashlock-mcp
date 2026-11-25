import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from './server.js';

// open_deal through the hosted server and the SDK's own client, against a /v1 that answers one thread.
const ID = '3f2a1b2c-1111-4111-8111-111111111111';
const DEAL_URL = `https://hashlock.test/deals/${ID}?from=api`; // what the API says, used as given
const openThread = { id: ID, status: 'open', makerId: 'u-maker', takerId: 'u-taker', takerAccepted: true, makerAccepted: false, dealUrl: DEAL_URL };
let reads = 0;
let v1: Server;
let app: ReturnType<typeof createHttpApp>;
beforeAll(async () => {
  v1 = createServer((req, res) => {
    const path = req.url!.replace(/^\/v1/, '');
    const json = (body: unknown) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === `/threads/${ID}`) {
      reads++;
      return json({ thread: openThread, swap: null, rfq: {}, messages: [] });
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => v1.listen(0, '127.0.0.1', r));
  app = createHttpApp({ v1Url: `http://127.0.0.1:${(v1.address() as AddressInfo).port}/v1` });
});
afterAll(() => {
  v1.closeAllConnections();
  v1.close();
});

const clients: Client[] = [];
afterEach(async () => {
  reads = 0;
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** A client that records each link it is handed and answers `accept`, as a host does once the person is back. */
async function connect(options: ConstructorParameters<typeof Client>[1]) {
  const shown: { url: string; message: string }[] = [];
  const client = new Client({ name: 'test', version: '0' }, options);
  client.setRequestHandler('elicitation/create', async (req) => {
    const p = req.params as { mode?: string; url: string; message: string };
    if (p.mode === 'url') shown.push({ url: p.url, message: p.message });
    return { action: 'accept' };
  });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      fetch: (url, init) => app.request(String(url), init),
      requestInit: { headers: { authorization: 'Bearer hk_oa_test' } },
    }),
  );
  return { client, shown };
}
const modern = (elicitation: object) => connect({ versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: { elicitation } });
const ASK = 'Open the deal page for 3f2a1b2c…: it shows your next step (accept, add an address, fund, claim or refund) and when it closes.';
const STATE = { dealUrl: DEAL_URL, note: 'The deal page shows the next step and when it closes.', thread: openThread, swap: null };

describe('open_deal', () => {
  it("hands a client that can open links the API's dealUrl, once, then answers with the deal as it is by then", async () => {
    const { client, shown } = await modern({ url: {} });
    const r = await client.callTool({ name: 'open_deal', arguments: { id: ID } });
    expect(shown).toEqual([{ url: DEAL_URL, message: ASK }]);
    expect(reads).toBe(2); // the ask, and the retry that read the deal again
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(STATE);
  });

  it('returns the link and the state to a client that cannot open one', async () => {
    const { client, shown } = await modern({ form: {} });
    const r = await client.callTool({ name: 'open_deal', arguments: { id: ID } });
    expect(shown).toEqual([]);
    expect(r.structuredContent).toEqual(STATE);
  });

  it('a 2025-era client is not handed the link through elicitation, though it declared it', async () => {
    const { client, shown } = await connect({ capabilities: { elicitation: { url: {} } } });
    const r = await client.callTool({ name: 'open_deal', arguments: { id: ID } }, { timeout: 5_000 });
    expect(shown).toEqual([]);
    expect(r.structuredContent).toEqual(STATE);
  });

  it('is read-only: it changes nothing', async () => {
    const { client } = await modern({});
    const tool = (await client.listTools()).tools.find((t) => t.name === 'open_deal');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
