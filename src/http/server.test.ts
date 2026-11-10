import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createHttpApp } from './server.js';

// The API is never called: a body is refused, or fails to parse, before any tool runs.
const app = createHttpApp({ v1Url: 'http://127.0.0.1:9/v1' });
const post = (body: string, headers: Record<string, string> = {}) =>
  app.request('/mcp', {
    method: 'POST',
    body,
    headers: { authorization: 'Bearer x', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  });
const filler = (chars: number) => `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${'a'.repeat(chars)}"}}`;

describe('a key that /v1 has accepted', () => {
  it('leaves the address bucket for one of its own — the wiring between a tool call and the limiter', async () => {
    // A /v1 that accepts every key, and a limit of 2 a minute.
    const v1 = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end('{"userId":"u","scopes":[]}'));
    await new Promise<void>((r) => v1.listen(0, '127.0.0.1', r));
    const before = process.env.MCP_RATE_LIMIT_MAX;
    process.env.MCP_RATE_LIMIT_MAX = '2';
    const strict = createHttpApp({ v1Url: `http://127.0.0.1:${(v1.address() as AddressInfo).port}/v1` });
    if (before === undefined) delete process.env.MCP_RATE_LIMIT_MAX;
    else process.env.MCP_RATE_LIMIT_MAX = before;
    const from = (token: string, body: string) =>
      strict.request('/mcp', {
        method: 'POST',
        body,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '3.3.3.3' },
      });
    const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    try {
      // The address's first request: a tool call that /v1 answers 200.
      const whoami = await from('hk_live', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}');
      expect(whoami.status).toBe(200);
      await whoami.text(); // the tool has run by the time its answer is read
      expect((await from('invented-1', ping)).status).toBe(200); // the address's second
      expect((await from('invented-2', ping)).status).toBe(429); // the address is spent …
      expect((await from('hk_live', ping)).status).toBe(200); // … and the accepted key is not counted with it
    } finally {
      v1.closeAllConnections();
      v1.close();
    }
  });
});

describe('request body limit on /mcp', () => {
  const over = filler(1024 * 1024);

  it('refuses a body that declares more than 1 MB', async () => {
    const r = await post(over, { 'content-length': String(over.length) });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'request body too large' });
  });

  it('refuses a body with no declared length once it has read past 1 MB', async () => {
    expect((await post(over)).status).toBe(413);
  });

  it('lets a body as large as a standard Bitcoin transaction in hex through to the transport, which answers it', async () => {
    expect((await post(filler(800_000))).status).toBe(200);
  });
});

describe('batch limit on /mcp', () => {
  const batch = (n: number) => JSON.stringify(Array.from({ length: n }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' })));

  it('refuses a batch of more than 16 messages before any of them runs', async () => {
    const r = await post(batch(17));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'a batch may hold at most 16 messages' });
  });

  it('answers a batch of 16, and a single message', async () => {
    expect((await post(batch(16))).status).toBe(200);
    expect((await post('{"jsonrpc":"2.0","id":1,"method":"ping"}')).status).toBe(200);
  });

  it('refuses what is not a JSON-RPC message in one line, whatever it carries', async () => {
    const junk = { jsonrpc: '2.0', id: 1, method: 'ping', ...Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 1])) };
    for (const body of [junk, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, junk], null, 7, 'ping', [[]]]) {
      const r = await post(JSON.stringify(body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: not a JSON-RPC message' }, id: null });
    }
  });

  it('leaves a body that is not JSON to the transport, which reads it again and names the parse error', async () => {
    const r = await post('{not json');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe('GET /mcp', () => {
  it('is refused with 405: a server with no state between requests has no stream to offer', async () => {
    const r = await app.request('/mcp', { headers: { authorization: 'Bearer x', accept: 'text/event-stream' } });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST, DELETE');
  });

  it('still asks a caller with no token to authorize first', async () => {
    const r = await app.request('/mcp', { headers: { accept: 'text/event-stream' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
  });
});
