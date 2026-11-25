// (the shebang is injected by tsup's banner — see tsup.config.ts)
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { HashlockClient } from './client.js';
import { loadConfig } from './config.js';
import { logSdkError } from './lib/errors.js';
import { AgreementStore, SecretStore } from './secrets.js';
import { registerTools } from './tools.js';

/**
 * Hashlock Markets MCP server — the settlement layer for the agent economy, as MCP tools.
 * Non-custodial cross-chain OTC: sealed RFQ + negotiation + HTLC atomic settlement
 * (both legs settle or both refund; no custodian).
 *
 * Auth (env): HASHLOCK_TOKEN (a JWT), or a wallet — HASHLOCK_EVM_KEY (0x private key) or
 * HASHLOCK_BANKR_API_KEY (a Bankr wallet) — with which the server performs SIWE login itself; the
 * fully-autonomous path. HASHLOCK_API_URL overrides the endpoint.
 * Swap secrets are generated locally and stored at ~/.hashlock/mcp-secrets.json (0600).
 */
const cfg = loadConfig();
const api = new HashlockClient(cfg);
const secrets = new SecretStore(cfg.secretsPath);

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }; // ships in the npm tarball
const agreements = AgreementStore.besides(cfg.secretsPath);
serveStdio(() => {
  const server = new McpServer({ name: 'hashlock', version });
  registerTools(server, api, secrets, agreements);
  return server;
}, { onerror: logSdkError }); // stderr: stdout is the protocol
console.error(
  `[hashlock-mcp] ready — API ${cfg.apiUrl}, auth: ${cfg.token ? 'token' : cfg.evmKey ? 'evm-key (autonomous SIWE)' : cfg.bankrApiKey ? 'bankr wallet (autonomous SIWE)' : 'none (read-only)'}`,
);
