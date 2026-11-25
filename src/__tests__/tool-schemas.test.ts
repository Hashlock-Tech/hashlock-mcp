import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { createHttpApp } from '../http/server.js';
import { READ } from '../lib/annotations.js';
import { output, s, toolRegistrar } from '../lib/tool.js';
import { registerTools } from '../tools.js';

// The tool schemas as tools/list sends them, which is what a client compiles. A client that compiles them with a
// default (draft-07) Ajv throws on a `$schema` it has no meta-schema for, so no schema names a dialect, in any era.
type Options = ConstructorParameters<typeof Client>[1];
const app = createHttpApp({ v1Url: 'http://127.0.0.1:9/v1' });
const servers = {
  // As src/index.ts serves it, over an in-memory pipe instead of the process's stdio.
  stdio: (client: Client) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    serveStdio(() => {
      const server = new McpServer({ name: 't', version: '0' });
      registerTools(server, {} as never, {} as never, {} as never);
      return server;
    }, { transport: a });
    return client.connect(b);
  },
  hosted: (client: Client) =>
    client.connect(
      new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
        fetch: (url, init) => app.request(String(url), init),
        requestInit: { headers: { authorization: 'Bearer hk_live_test' } },
      }),
    ),
};
const eras: Record<string, Options> = {
  '2025-06-18': { supportedProtocolVersions: ['2025-06-18'] },
  '2025-11-25': { supportedProtocolVersions: ['2025-11-25'] },
  '2026-07-28': { versionNegotiation: { mode: { pin: '2026-07-28' } } },
};

async function listTools(name: keyof typeof servers, options: Options) {
  const client = new Client({ name: 'c', version: '0' }, options);
  await servers[name](client);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe.each(Object.keys(servers) as (keyof typeof servers)[])('%s tools/list', (name) => {
  it.each(Object.keys(eras))('names no JSON Schema dialect for a %s client', async (era) => {
    const tools = await listTools(name, eras[era]);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.inputSchema, t.name).not.toHaveProperty('$schema');
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.outputSchema, t.name).not.toHaveProperty('$schema');
    }
  });

  // Ajv's defaults but one: formats ("uuid") are a plugin a client adds (ajv-formats), and are not the question here.
  it("compiles every tool's input and output schema with a draft-07 Ajv", async () => {
    const ajv = new Ajv({ validateFormats: false });
    for (const t of await listTools(name, eras['2025-06-18']!)) {
      expect(() => ajv.compile(t.inputSchema), `${t.name} input`).not.toThrow();
      expect(() => ajv.compile(t.outputSchema!), `${t.name} output`).not.toThrow();
    }
  });
});

// The hosted server registers its tools on every request, with output schemas made once per process: registering
// must leave them as they are, or each request wraps their converter again and tools/list slows without end.
it('registering a tool leaves the output schema it was given unchanged', () => {
  const out = output({ id: s() });
  const before = out['~standard'];
  for (const n of [1, 2]) toolRegistrar(new McpServer({ name: 't', version: '0' }))(`t${n}`, 'd', {}, READ, out, async () => ({ content: [] }));
  expect(out['~standard']).toBe(before);
});
