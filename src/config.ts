/**
 * Environment-driven config. Auth is autonomous per chain — the agent owns its key(s) and the server
 * performs the login (nonce → sign → JWT) with no human in the loop. Any ONE of:
 *  - HASHLOCK_TOKEN    — a ready JWT (copy from an authenticated session)
 *  - HASHLOCK_EVM_KEY  — 0x… 32-byte hex; SIWE (personal_sign) login, and signs EVM fund/claim
 *  - HASHLOCK_TRON_KEY — 64-hex (TronLink-style); TRON signMessageV2 login, and signs TRON fund/claim
 *  - HASHLOCK_BTC_KEY  — WIF; BIP-322 login, and signs BTC HTLC claims
 *  - HASHLOCK_SOLANA_KEY — base58 (the 64-byte export a wallet gives, or a 32-byte seed). SIGNING
 *    ONLY, not a login: the server builds each Solana transaction and this key puts one signature in
 *    it. Set it alongside whichever key logs the agent in.
 * With none set, read-only tools (board/assets) still work; authed tools return UNAUTHORIZED.
 * The first configured key (EVM → TRON → BTC) is used for the login that mints the session JWT.
 */
export interface Config {
  apiUrl: string;
  appUrl: string;
  token?: string;
  evmKey?: `0x${string}`;
  tronKey?: string; // 64-hex, no 0x
  btcKey?: string; // WIF
  solanaKey?: string; // base58, 32- or 64-byte
  // Public RPC endpoints the agent submits fund/claim txs through (chain ids/contracts come from
  // GET /config; the BTC Esplora base also comes from /config). Testnet defaults.
  evmRpc: string;
  tronHost: string;
  secretsPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = (env.HASHLOCK_API_URL || 'https://dev.hashlock.markets/api').replace(/\/+$/, '');
  // The user-facing app base (for shareable order/deal links). Default: the API host with /api → /app.
  const appUrl = (env.HASHLOCK_APP_URL || apiUrl.replace(/\/api$/, '/app')).replace(/\/+$/, '');

  const evmKey = env.HASHLOCK_EVM_KEY?.trim();
  if (evmKey && !/^0x[0-9a-fA-F]{64}$/.test(evmKey)) {
    throw new Error('HASHLOCK_EVM_KEY must be a 0x-prefixed 32-byte hex private key');
  }
  let tronKey = env.HASHLOCK_TRON_KEY?.trim();
  if (tronKey) {
    tronKey = tronKey.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(tronKey)) {
      throw new Error('HASHLOCK_TRON_KEY must be a 32-byte hex private key');
    }
  }
  const btcKey = env.HASHLOCK_BTC_KEY?.trim();
  if (btcKey && !/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(btcKey)) {
    throw new Error('HASHLOCK_BTC_KEY must be a WIF private key');
  }

  const solanaKey = env.HASHLOCK_SOLANA_KEY?.trim();
  // Only the alphabet is checked here; the length is settled by SolanaSigner, which decodes it. A
  // regex on length would have to encode base58's variable expansion and would get it wrong.
  if (solanaKey && !/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(solanaKey)) {
    throw new Error('HASHLOCK_SOLANA_KEY must be a base58 secret key');
  }

  return {
    apiUrl,
    appUrl,
    token: env.HASHLOCK_TOKEN?.trim() || undefined,
    evmKey: evmKey as `0x${string}` | undefined,
    tronKey,
    btcKey,
    solanaKey,
    evmRpc: (env.HASHLOCK_EVM_RPC || 'https://ethereum-sepolia-rpc.publicnode.com').replace(/\/+$/, ''),
    tronHost: (env.HASHLOCK_TRON_HOST || 'https://nile.trongrid.io').replace(/\/+$/, ''),
    secretsPath: env.HASHLOCK_SECRETS_PATH || `${env.HOME || env.USERPROFILE || '.'}/.hashlock/mcp-secrets.json`,
  };
}
