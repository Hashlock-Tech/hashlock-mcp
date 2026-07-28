import { serve } from '@hono/node-server';
import { createRequire } from 'node:module';
import { createHttpApp } from './server.js';

/**
 * Entry point for the HOSTED remote MCP service (Streamable HTTP). Deployed behind a reverse proxy
 * at hashlock.markets/mcp. Config via env:
 *   HASHLOCK_V1_URL  developer API base (default https://api.hashlock.markets/v1)
 *   PORT             listen port (default 8080)
 * Testnets only until the hardening gate.
 */
const version = (() => {
  try {
    return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const v1Url = (process.env.HASHLOCK_V1_URL ?? 'https://api.hashlock.markets/v1').replace(/\/+$/, '');
const port = Number(process.env.PORT ?? 8080);

const app = createHttpApp({ v1Url, version });

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.error(`[hashlock-mcp-http] ready on :${info.port} — proxying ${v1Url}`);
});
