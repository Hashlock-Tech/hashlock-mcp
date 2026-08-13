import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rateLimit } from './rate-limit.js';
import { registerHostedTools } from './tools.js';
import { makeCallV1 } from './v1-client.js';

/**
 * HOSTED remote MCP server (Streamable HTTP), served at e.g. hashlock.markets/mcp so anyone can
 * connect from an MCP client by URL. STATELESS: each request builds a fresh McpServer + transport
 * (the SDK's recommended stateless mode), so there is no cross-request session state to leak.
 *
 * Auth (MVP): the caller presents their own Hashlock developer key (`hk_…`, from
 * hashlock.markets/developers) as `Authorization: Bearer …`; it is forwarded to `/v1` unchanged and
 * never stored. OAuth 2.1 (one-click connect for Claude/ChatGPT, minting a scoped key after Privy
 * login) is the next slice — @hono/mcp ships mcpAuthRouter/bearerAuth for it.
 */
export interface HttpServerOptions {
  /** Base URL of the developer API, e.g. https://api.hashlock.markets/v1 */
  v1Url: string;
  /** Public origin of this deployment — used to point clients at the OAuth metadata (RFC 9728). */
  publicUrl?: string;
  name?: string;
  version?: string;
}

const bearer = (h: string | undefined): string | undefined =>
  h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;

export function createHttpApp(opts: HttpServerOptions): Hono {
  const app = new Hono();

  app.use('/mcp', cors({ origin: '*', allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'], exposeHeaders: ['Mcp-Session-Id'] }));

  // Bound the public endpoint itself. /v1 limits per API key downstream, but that only helps once a
  // credential is presented — this sits in front of that.
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: Number(process.env.MCP_RATE_LIMIT_MAX ?? 240) }));

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

    // Fresh per-request server + transport (stateless). Tools proxy to /v1 with THIS caller's key.
    const server = new McpServer({ name: opts.name ?? 'hashlock', version: opts.version ?? '0.0.0' });
    registerHostedTools(server, makeCallV1(opts.v1Url, token));

    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });

  return app;
}
