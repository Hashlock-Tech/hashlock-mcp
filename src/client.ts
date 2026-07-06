import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';

/**
 * Thin typed client for the Hashlock Markets REST API.
 * Auth: a static JWT (HASHLOCK_TOKEN), or autonomous SIWE login with HASHLOCK_EVM_KEY —
 * the client fetches a nonce, signs it locally (personal_sign) and exchanges it for a JWT.
 * On a 401 with a key present it re-logs-in once and retries (JWTs expire).
 */

// ── API shapes (subset the tools use) ────────────────────────────────────────
export interface Asset {
  id: string;
  symbol: string;
  name: string | null;
  chain: string;
  decimals: number;
}
export interface Rfq {
  id: string;
  creatorId: string;
  direction: 'sell_base' | 'buy_base';
  baseAssetId: string;
  baseAmount: string;
  quoteAssetId: string;
  askAmount: string | null;
  visibility: 'public' | 'private';
  targetAddress: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
}
export interface Thread {
  id: string;
  rfqId: string;
  makerId: string;
  takerId: string;
  status: string;
  currentQuoteAmount: string | null;
  pendingAmount: string | null;
  pendingBy: string | null;
  takerAccepted: boolean;
  makerAccepted: boolean;
  hashlock: string | null;
}
export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  kind: string;
  body: string | null;
  amount: string | null;
  createdAt: string;
}
export interface Swap {
  id: string;
  threadId: string;
  makerId: string;
  takerId: string;
  status: string;
  hashlock: string;
  initiatorRole: 'maker' | 'taker';
  [k: string]: unknown;
}
export interface User {
  id: string;
  evmAddress: string | null;
  tronAddress: string | null;
  btcAddress: string | null;
  telegramId: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class HashlockClient {
  private token: string | undefined;
  private assetCache: Asset[] | null = null;

  constructor(private readonly cfg: Config) {
    this.token = cfg.token;
  }

  // ── transport ───────────────────────────────────────────────────────────────
  private async req<T>(
    path: string,
    opts: { method?: string; body?: unknown; auth?: boolean; retried?: boolean } = {},
  ): Promise<T> {
    const { method = opts.body !== undefined ? 'POST' : 'GET', body, auth = true } = opts;
    if (auth && !this.token) await this.login();
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && this.cfg.evmKey && !opts.retried) {
      this.token = undefined; // expired JWT → one fresh SIWE login, then retry
      return this.req(path, { ...opts, retried: true });
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      throw new ApiError(String(json?.error ?? `HTTP ${res.status}`), res.status);
    }
    return json as T;
  }

  /** Autonomous SIWE login with the configured private key. */
  private async login(): Promise<void> {
    if (!this.cfg.evmKey) {
      throw new ApiError(
        'unauthorized — set HASHLOCK_TOKEN (a JWT) or HASHLOCK_EVM_KEY (0x private key for autonomous SIWE login)',
        401,
      );
    }
    const account = privateKeyToAccount(this.cfg.evmKey);
    const { nonce } = await this.req<{ nonce: string }>('/auth/siwe/nonce', { auth: false });
    const message = `Hashlock Markets wants you to sign in.\n\nAddress: ${account.address}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    const signature = await account.signMessage({ message });
    const res = await this.req<{ token: string; user: User }>('/auth/siwe/verify', {
      auth: false,
      body: { address: account.address, message, signature },
    });
    this.token = res.token;
  }

  // ── assets ──────────────────────────────────────────────────────────────────
  async assets(): Promise<Asset[]> {
    if (!this.assetCache) {
      const { assets } = await this.req<{ assets: Asset[] }>('/assets', { auth: false });
      this.assetCache = assets;
    }
    return this.assetCache;
  }

  /** Resolve an asset by id (uuid), "SYMBOL@chain", or bare symbol when unambiguous. */
  async resolveAsset(ref: string): Promise<Asset> {
    const assets = await this.assets();
    const r = ref.trim();
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(r)) {
      const byId = assets.find((a) => a.id === r);
      if (byId) return byId;
      throw new Error(`unknown asset id "${r}" — call list_assets`);
    }
    const [sym, chain] = r.split('@');
    const matches = assets.filter(
      (a) =>
        a.symbol.toLowerCase() === sym!.trim().toLowerCase() &&
        (!chain || a.chain.toLowerCase() === chain.trim().toLowerCase()),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`unknown asset "${r}" — call list_assets for the registry`);
    throw new Error(
      `ambiguous asset "${r}" — matches ${matches.map((a) => `${a.symbol}@${a.chain}`).join(', ')}; use SYMBOL@chain`,
    );
  }

  // ── endpoints ───────────────────────────────────────────────────────────────
  me = () => this.req<{ user: User | null }>('/me');
  listRfqs = (q: { baseAssetId?: string; quoteAssetId?: string; direction?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return this.req<{ rfqs: Rfq[] }>(`/rfqs${qs.size ? `?${qs}` : ''}`, { auth: false });
  };
  getRfq = (id: string) => this.req<{ rfq: Rfq }>(`/rfqs/${id}`, { auth: false });
  createRfq = (body: Record<string, unknown>) => this.req<{ rfq: Rfq }>('/rfqs', { body });
  cancelRfq = (id: string) => this.req<{ rfq: Rfq }>(`/rfqs/${id}/cancel`, { body: {} });
  postQuote = (id: string, quoteAmount: string) =>
    this.req<{ quote: unknown; thread: Thread }>(`/rfqs/${id}/quotes`, { body: { quoteAmount } });

  getThread = (id: string) =>
    this.req<{ thread: Thread; rfq: Rfq; messages: Message[]; swap: Swap | null }>(`/threads/${id}`);
  postMessage = (id: string, body: string) => this.req(`/threads/${id}/messages`, { body: { body } });
  propose = (id: string, quoteAmount: string) =>
    this.req<{ thread: Thread }>(`/threads/${id}/propose`, { body: { quoteAmount } });
  acceptProposal = (id: string) => this.req<{ thread: Thread }>(`/threads/${id}/accept-proposal`, { body: {} });
  accept = (id: string, hashlock?: string) =>
    this.req<{ thread: Thread; swap?: Swap }>(`/threads/${id}/accept`, { body: hashlock ? { hashlock } : {} });
  reject = (id: string) => this.req(`/threads/${id}/reject`, { body: {} });

  myRfqs = () => this.req<{ rfqs: Rfq[] }>('/me/rfqs');
  myThreads = () => this.req<{ threads: Thread[] }>('/me/threads');
  getSwap = (id: string) => this.req<{ swap: Swap }>(`/swaps/${id}`);
  setSwapAddress = (id: string, chain: string, address: string) =>
    this.req<{ swap: Swap }>(`/swaps/${id}/address`, { body: { chain, address } });
  reveal = (id: string, body: { secret: string; claimTx?: string; leg?: 'a' | 'b' }) =>
    this.req<{ swap: Swap }>(`/swaps/${id}/reveal`, { body });
}

// ── amount conversion (exact, bigint) ───────────────────────────────────────
export function toBaseUnits(human: string, decimals: number): string {
  const cleaned = human.replace(/[,\s_]/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    throw new Error(`invalid amount "${human}" — expected a positive decimal like "0.5"`);
  }
  const [whole = '0', frac = ''] = cleaned.split('.');
  if (frac.length > decimals) {
    throw new Error(`amount "${human}" has more than ${decimals} decimal places`);
  }
  const v = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (v <= 0n) throw new Error(`amount must be positive, got "${human}"`);
  return v.toString();
}

export function fromBaseUnits(base: string | null, decimals: number): string | null {
  if (base === null || base === undefined) return null;
  const n = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const frac = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${n / d}.${frac}` : (n / d).toString();
}
