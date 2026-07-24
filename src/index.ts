// (the shebang is injected by tsup's banner — see tsup.config.ts)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HashlockClient } from './client.js';
import { loadConfig } from './config.js';
import { SecretStore } from './secrets.js';
import { registerTools } from './tools.js';

/**
 * Hashlock Markets MCP server — the settlement layer for the agent economy, as MCP tools.
 * Non-custodial cross-chain OTC: sealed RFQ + negotiation + HTLC atomic settlement
 * (both legs settle or both refund; no custodian). TESTNETS ONLY until the hardening gate.
 *
 * Auth (env): HASHLOCK_TOKEN (a JWT) or HASHLOCK_EVM_KEY (0x private key — the server performs
 * SIWE login itself; the fully-autonomous path). HASHLOCK_API_URL overrides the endpoint.
 * Swap secrets are generated locally and stored at ~/.hashlock/mcp-secrets.json (0600).
 */
const cfg = loadConfig();
const api = new HashlockClient(cfg);
const secrets = new SecretStore(cfg.secretsPath);

const server = new McpServer({ name: 'hashlock', version: '1.0.0-rc.2' });
registerTools(server, api, secrets);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[hashlock-mcp] ready — API ${cfg.apiUrl}, auth: ${cfg.token ? 'token' : cfg.evmKey ? 'evm-key (autonomous SIWE)' : 'none (read-only)'}`,
);
