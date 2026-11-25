import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { logSdkError } from '../lib/errors.js';
import { loadSkills } from '../lib/skills.js';
import { keyAnswered, rateLimit } from './rate-limit.js';
import { ASSISTANT_INSTRUCTIONS, HOSTED_INSTRUCTIONS, isAssistantKey, registerHostedTools } from './tools.js';
import { makeCallV1 } from './v1-client.js';

/**
 * HOSTED remote MCP server (Streamable HTTP), served at e.g. hashlock.markets/mcp so anyone can
 * connect from an MCP client by URL. STATELESS: each request builds a fresh McpServer (createMcpHandler),
 * so there is no cross-request session state to leak.
 *
 * Auth: the caller presents a Hashlock developer key (`hk_…`) as `Authorization: Bearer …` — one made
 * at hashlock.markets/developers, or the one an MCP client gets through OAuth (the authorization server
 * is the API: /.well-known/oauth-authorization-server, /oauth/authorize, /api/oauth/token). It is
 * forwarded to `/v1` unchanged and never stored. Without one, the 401 below points the client at the
 * protected-resource metadata so it can start that sign-in.
 */
export interface HttpServerOptions {
  /** Base URL of the developer API, e.g. https://api.hashlock.markets/v1 */
  v1Url: string;
  /** Public origin of this deployment — used to point clients at the OAuth metadata (RFC 9728). */
  publicUrl?: string;
  name?: string;
  version?: string;
}

/** The most messages one POST may carry. */
const MAX_BATCH = 16;

/** Every member a JSON-RPC 2.0 message can have: a request, a notification, a result or an error. */
const MEMBERS = new Set(['jsonrpc', 'id', 'method', 'params', 'result', 'error']);
const isMessage = (m: unknown): boolean =>
  typeof m === 'object' && m !== null && !Array.isArray(m) && Object.keys(m).every((k) => MEMBERS.has(k));

const NOT_JSON = Symbol('not JSON');

// The same path from src/http/server.ts and from the bundle, dist/http/index.js. The image copies skills/ beside dist/.
const skills = await loadSkills(fileURLToPath(new URL('../../skills', import.meta.url)));

const bearer = (h: string | undefined): string | undefined =>
  h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;

export function createHttpApp(opts: HttpServerOptions): Hono {
  const app = new Hono();

  // One server per request, for the caller whose key the route hands over as authInfo. Tools proxy to /v1 with THAT key.
  // A key from the OAuth flow is a chat assistant's: it gets the tools without the settlement builders and relay
  // (isAssistantKey). The handler serves 2025-era clients (initialize) and 2026-07-28 ones alike.
  // Nothing here ever changes a list, so no listChanged is advertised and no subscriptions/listen stream is opened
  // (maxSubscriptions: 0): a listen is refused in-band at once. Each would sit idle, with keepalives, until its caller
  // left, and any `Bearer x` could open up to the default 1024 (1000 held 41 MB) — as GET streams once did.
  const handler = createMcpHandler(({ authInfo }) => {
    const token = authInfo!.token;
    const assistant = isAssistantKey(token);
    // The skill is written for a developer key: these tools' names, and an agent that makes its own swap secret. A chat
    // assistant has no settlement tools and must never make a secret, so its key gets no skill, and no resources.
    const skill = assistant ? undefined : skills;
    const server = new McpServer(
      { name: opts.name ?? 'hashlock', version: opts.version ?? '0.0.0' },
      { instructions: assistant ? ASSISTANT_INSTRUCTIONS : HOSTED_INSTRUCTIONS, capabilities: { tools: { listChanged: false }, ...(skill && { resources: { listChanged: false } }) } },
    );
    const callV1 = makeCallV1(opts.v1Url, token);
    registerHostedTools(
      server,
      async (path, init) => {
        const r = await callV1(path, init);
        keyAnswered(token, r.status); // what earns this key a rate-limit bucket of its own, or loses it
        return r;
      },
      { settlement: !assistant },
    );
    skill?.attach(server);
    return server;
  }, { maxSubscriptions: 0, onerror: logSdkError });

  // A browser client sends MCP-Protocol-Version, and from 2026-07-28 Mcp-Method, Mcp-Name and Mcp-Param-* headers too:
  // with no allowHeaders list, a preflight is allowed whatever headers it asks for. Auth is a bearer header, not a
  // cookie, so any origin may send it. Exposed, so a browser client can read them: WWW-Authenticate, the 401's
  // resource_metadata pointer, and the backoff the limiter below sends with a 429. GET and DELETE are allowed too:
  // a 2025-era browser client opens GET (the SSE stream) with headers that need a preflight, and must get the handler's
  // 405, which it handles, not a failed preflight, which it sees only as a network error. No stream is ever held.
  app.use('/mcp', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['WWW-Authenticate', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  }));

  // Bound the public endpoint itself. /v1 limits per API key downstream, but that only helps once a
  // credential is presented — this sits in front of that. Per address, until /v1 has accepted the key.
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: Number(process.env.MCP_RATE_LIMIT_MAX ?? 240) }));

  // No request body is read past 1 MB. Anything after "Bearer " reaches the transport — the key is only
  // checked by /v1, when a tool runs — so without this an anonymous caller chose how much this process
  // buffers and parses. 1 MB is what the API behind it accepts: the largest call is a raw Bitcoin
  // transaction in hex, at most 800 000 characters. After the limiter, so a caller over its rate is
  // answered 429 without its body being read.
  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'request body too large' }, 413) }));

  app.get('/health', (c) => c.json({ status: 'ok', service: 'hashlock-mcp-http', ts: new Date().toISOString() }));

  app.all('/mcp', async (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) {
      // The `resource_metadata` pointer is what turns this into one-click connect: a client that gets
      // this 401 fetches the metadata, discovers the authorization server, registers itself and runs
      // the OAuth flow on its own (RFC 9728). Without it the user has to paste a key by hand.
      const rm = opts.publicUrl ? `, resource_metadata="${opts.publicUrl.replace(/\/+$/, '')}/.well-known/oauth-protected-resource"` : '';
      c.header('WWW-Authenticate', `Bearer realm="hashlock", error="invalid_token"${rm}`);
      return c.json({ error: 'authorization required — connect through your MCP client, or use a key from /developers' }, 401);
    }

    // A JSON-RPC batch is one request to the limiter and one body to the limit above, and as many calls
    // as it holds: 20 000 `tools/list` fit in 1 MB, and answering them took this process to 2465 MB and
    // sent 762 MB back (measured). The body is read here, once, and handed to the handler as read — so a
    // body that is not JSON is answered here too: the handler cannot read it again.
    // Batching left MCP in 2025-06-18; MAX_BATCH is room for a client still on the revision that had it.
    const body: unknown = c.req.method === 'POST' ? await c.req.json().catch(() => NOT_JSON) : undefined;
    if (body === NOT_JSON) return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }, 400);
    if (Array.isArray(body) && body.length > MAX_BATCH) return c.json({ error: `a batch may hold at most ${MAX_BATCH} messages` }, 400);
    // What is not a JSON-RPC message is refused here, in one line. The transport refuses it too, but by
    // listing every member it did not expect, once per kind of message, and sending the list back: one
    // message of 90 000 junk members, 978 930 bytes, was answered with 14 672 694.
    if (body !== undefined && !(Array.isArray(body) ? body : [body]).every(isMessage))
      return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: not a JSON-RPC message' }, id: null }, 400);

    // The key is forwarded, not verified: /v1 checks it when a tool runs.
    return handler.fetch(c.req.raw, { authInfo: { token, clientId: '', scopes: [] }, parsedBody: body });
  });

  return app;
}
