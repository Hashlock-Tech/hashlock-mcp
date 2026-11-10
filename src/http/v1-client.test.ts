import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCallV1 } from './v1-client.js';

// A /v1 that accepts the connection and never answers, one that answers and stalls in the body, and one that answers.
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1/ok') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1"}');
    if (req.url === '/v1/html') return void res.writeHead(502, { 'content-type': 'text/html' }).end('<html>bad gateway</html>');
    if (req.url === '/v1/half') return void res.writeHead(200, { 'content-type': 'application/json' }).write('{"id":');
    // anything else: silence
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('makeCallV1', () => {
  it('passes an answer through, JSON or not', async () => {
    const call = makeCallV1(base, 'hk_test');
    expect(await call('/ok')).toEqual({ status: 200, json: { id: '1' } });
    expect(await call('/html')).toEqual({ status: 502, json: { error: 'non-JSON 502 response' } });
  });

  it('stops waiting for a /v1 that does not answer, and says a read changed nothing', async () => {
    const r = await makeCallV1(base, 'hk_test', 50)('/silent');
    expect(r).toEqual({ status: 504, json: { error: 'the Hashlock API did not answer in 0 s — nothing was changed; try again' } });
  });

  it('says a write may have taken effect, whether the headers or the body never came', async () => {
    for (const path of ['/silent', '/half']) {
      const r = await makeCallV1(base, 'hk_test', 50)(path, { method: 'POST', body: { a: 1 } });
      expect(r.status).toBe(504);
      expect((r.json as { error: string }).error).toContain('may or may not have taken effect');
    }
  });

  it('gives one MCP request one clock, however many calls its tool makes', async () => {
    const call = makeCallV1(base, 'hk_test', 50);
    expect((await call('/silent')).status).toBe(504);
    expect((await call('/ok')).status).toBe(504); // the request's time is spent: an answer that would have come is not waited for
  });

  it('says the same of an API it could not reach at all', async () => {
    const down = makeCallV1('http://127.0.0.1:9/v1', 'hk_test');
    expect(await down('/me')).toEqual({ status: 502, json: { error: 'the Hashlock API could not be reached — nothing was changed; try again' } });
    const r = await down('/rfqs', { method: 'POST', body: {} });
    expect(r.status).toBe(502);
    expect((r.json as { error: string }).error).toContain('may or may not have taken effect');
  });
});
