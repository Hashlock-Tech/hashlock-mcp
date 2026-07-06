/**
 * Environment-driven config. Two auth modes, checked in order:
 *  1. HASHLOCK_TOKEN     — a ready JWT (copy from an authenticated session).
 *  2. HASHLOCK_EVM_KEY   — a 0x… private key; the server performs the SIWE login itself
 *                          (nonce → personal_sign → JWT). This is the fully-autonomous-agent
 *                          path: the agent owns its key, no human in the loop.
 * With neither set, read-only tools (board/assets) still work; authed tools return UNAUTHORIZED.
 */
export interface Config {
  apiUrl: string;
  token?: string;
  evmKey?: `0x${string}`;
  secretsPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = (env.HASHLOCK_API_URL || 'https://dev.hashlock.markets/api').replace(/\/+$/, '');
  const evmKey = env.HASHLOCK_EVM_KEY?.trim();
  if (evmKey && !/^0x[0-9a-fA-F]{64}$/.test(evmKey)) {
    throw new Error('HASHLOCK_EVM_KEY must be a 0x-prefixed 32-byte hex private key');
  }
  return {
    apiUrl,
    token: env.HASHLOCK_TOKEN?.trim() || undefined,
    evmKey: evmKey as `0x${string}` | undefined,
    secretsPath:
      env.HASHLOCK_SECRETS_PATH ||
      `${env.HOME || env.USERPROFILE || '.'}/.hashlock/mcp-secrets.json`,
  };
}
