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

  it('leaves a body that is not JSON to the transport, which reads it again and names the parse error', async () => {
    const r = await post('{not json');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});
