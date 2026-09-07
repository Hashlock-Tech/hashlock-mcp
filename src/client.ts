import { BtcSigner, type BtcChain } from './chains/btc.js';
import { EvmSigner, type EvmChain } from './chains/evm.js';
import { SolanaSigner } from './chains/solana.js';
import { TronSigner, type TronChain } from './chains/tron.js';
import type { Config } from './config.js';

/** A server-built Solana transaction, ready for one signature. */
export interface SolanaLegTx {
  chain: string;
  family: string;
  sign: 'solana-tx';
  escrow: string;
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Chain params from GET /config — what the signers need to build fund/claim txs. */
export interface ChainConfig {
  fee: { bps: number; payer: string };
  evm: { chainId: number | null; factory: string | null; rpcUrl?: string | null };
  tron: { sharedHtlc: string | null; fullHost?: string | null };
  btc: { network: string; esplora: string | null; treasury: string | null };
}

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
  address: string | null; // null => native coin
  isNative?: boolean;
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
export interface SwapLeg {
  assetId: string;
  chain: string;
  amount: string;
  timelock: string;
  payoutAddress: string | null;
  refundAddress: string | null;
  htlcAddress: string | null;
  redeemScript: string | null;
  fundTx: string | null;
  claimTx: string | null;
}
export interface Swap {
  id: string;
  threadId: string;
  makerId: string;
  takerId: string;
  initiatorUserId: string;
  status: string;
  hashlock: string;
  secretCiphertext: string | null;
  onchainSwapId: string | null;
  feePayerId: string | null;
  feeAssetId: string | null;
  feeAmount: string;
  // Leg A (maker gives) / Leg B (maker wants) — flat columns in the DB row.
  aAssetId: string;
  aChain: string;
  aAmount: string;
  aTimelock: string;
  aPayoutAddress: string | null;
  aRefundAddress: string | null;
  aHtlcAddress: string | null;
  aRedeemScript: string | null;
  aFundTx: string | null;
  aClaimTx: string | null;
  bAssetId: string;
  bChain: string;
  bAmount: string;
  bTimelock: string;
  bPayoutAddress: string | null;
  bRefundAddress: string | null;
  bHtlcAddress: string | null;
  bRedeemScript: string | null;
  bFundTx: string | null;
  bClaimTx: string | null;
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

  /** User-facing app base (for shareable order/deal links). */
  get appUrl(): string {
    return this.cfg.appUrl;
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
        'x-hashlock-client': 'mcp',
        ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && this.hasKey && !opts.retried) {
      this.token = undefined; // expired JWT → one fresh login, then retry
      return this.req(path, { ...opts, retried: true });
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      throw new ApiError(String(json?.error ?? `HTTP ${res.status}`), res.status);
    }
    return json as T;
  }

  // ── autonomous signers (lazy, from the configured key per family) ────────────
  private _evm: EvmSigner | null = null;
  private _tron: TronSigner | null = null;
  private _btc: BtcSigner | null = null;
  private _solana: SolanaSigner | null = null;
  private chainCfg: ChainConfig | null = null;

  private get hasKey(): boolean {
    return !!(this.cfg.evmKey || this.cfg.tronKey || this.cfg.btcKey);
  }
  evmSigner(): EvmSigner {
    if (!this.cfg.evmKey) throw new Error('HASHLOCK_EVM_KEY not set');
    return (this._evm ??= new EvmSigner(this.cfg.evmKey));
  }
  tronSigner(): TronSigner {
    if (!this.cfg.tronKey) throw new Error('HASHLOCK_TRON_KEY not set');
    return (this._tron ??= new TronSigner(this.cfg.tronKey));
  }
  solanaSigner(): SolanaSigner {
    if (!this.cfg.solanaKey) throw new Error('HASHLOCK_SOLANA_KEY not set');
    return (this._solana ??= new SolanaSigner(this.cfg.solanaKey));
  }
  async btcSigner(): Promise<BtcSigner> {
    if (!this.cfg.btcKey) throw new Error('HASHLOCK_BTC_KEY not set');
    if (!this._btc) {
      const cc = await this.chainConfig();
      this._btc = new BtcSigner(this.cfg.btcKey, cc.btc.network);
    }
    return this._btc;
  }

  /** GET /config (chain params), cached. RPC/host come from local env (not exposed by the API). */
  async chainConfig(): Promise<ChainConfig> {
    if (!this.chainCfg) {
      const raw = await this.req<ChainConfig>('/config', { auth: false });
      this.chainCfg = raw;
    }
    return this.chainCfg;
  }
  async evmChain(): Promise<EvmChain> {
    const cc = await this.chainConfig();
    if (!cc.evm.factory || cc.evm.chainId == null) throw new Error('EVM settlement not configured on this API');
    return { rpcUrl: this.cfg.evmRpc, chainId: cc.evm.chainId, factory: cc.evm.factory as `0x${string}` };
  }
  async tronChain(): Promise<TronChain> {
    const cc = await this.chainConfig();
    if (!cc.tron.sharedHtlc) throw new Error('TRON settlement not configured on this API');
    return { fullHost: this.cfg.tronHost, sharedHtlc: cc.tron.sharedHtlc };
  }
  async btcChain(): Promise<BtcChain> {
    const cc = await this.chainConfig();
    if (!cc.btc.esplora) throw new Error('BTC settlement not configured on this API');
    return { network: cc.btc.network, esplora: cc.btc.esplora, treasury: cc.btc.treasury };
  }

  /**
   * Autonomous login. Picks the first configured key (EVM → TRON → BTC), signs a domain-bound nonce
   * message, and exchanges it for a session JWT via the matching verify endpoint.
   */
  private async login(): Promise<void> {
    if (!this.hasKey) {
      throw new ApiError(
        'unauthorized — set HASHLOCK_TOKEN, or a key for autonomous login: HASHLOCK_EVM_KEY / HASHLOCK_TRON_KEY / HASHLOCK_BTC_KEY',
        401,
      );
    }
    const { nonce } = await this.req<{ nonce: string }>('/auth/siwe/nonce', { auth: false });
    const stamp = new Date().toISOString();
    let path: string;
    let address: string;
    let message: string;
    let signature: string;

    if (this.cfg.evmKey) {
      const s = this.evmSigner();
      address = s.address;
      message = `Hashlock Markets wants you to sign in.\n\nAddress: ${address}\nNonce: ${nonce}\nIssued At: ${stamp}`;
      signature = await s.signLoginMessage(message);
      path = '/auth/siwe/verify';
    } else if (this.cfg.tronKey) {
      const s = this.tronSigner();
      address = s.address;
      message = `Hashlock Markets wants you to sign in.\n\nAddress: ${address}\nNonce: ${nonce}\nIssued At: ${stamp}`;
      signature = await s.signLoginMessage(message, await this.tronChain());
      path = '/auth/tron/verify';
    } else {
      const s = await this.btcSigner();
      address = s.address;
      message = `Hashlock Markets — sign in.\n\nAddress: ${address}\nNonce: ${nonce}\nIssued At: ${stamp}`;
      signature = s.signLoginMessage(message);
      path = '/auth/btc/verify';
    }

    const res = await this.req<{ token: string; user: User }>(path, { auth: false, body: { address, message, signature } });
    this.token = res.token;
    await this.linkSolana();
  }

  private solanaLinked = false;
  /**
   * Prove the agent owns its Solana wallet, so the account row carries the address.
   *
   * Signing is not enough on its own: rfq/service.ts refuses to create an order whose GIVE leg is
   * Solana unless users.solanaAddress is set, and setSwapAddress writes the address book, not that
   * column. Without this the agent could only ever be the taker on a Solana pair — half a rail.
   *
   * Best-effort and one attempt per process: the wallet may already belong to another account (409),
   * which no amount of retrying fixes, and a login that fails because of it would be worse than a
   * session that can still browse, quote and settle every other chain.
   */
  private async linkSolana(): Promise<void> {
    if (this.solanaLinked || !this.cfg.solanaKey) return;
    this.solanaLinked = true;
    try {
      const s = this.solanaSigner();
      const { nonce } = await this.req<{ nonce: string }>('/auth/siwe/nonce', { auth: false });
      const message = `Hashlock Markets wants you to sign in.\n\nAddress: ${s.address}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
      await this.req('/me/link-solana', { body: { address: s.address, message, signature: s.signLoginMessage(message) } });
    } catch {
      /* already linked elsewhere, or the API is old — settlement on other chains must still work */
    }
  }

  /** The addresses this process can actually sign for, whatever the account row says. */
  localSigners(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.cfg.evmKey) out.evm = this.evmSigner().address;
    if (this.cfg.tronKey) out.tron = this.tronSigner().address;
    if (this.cfg.solanaKey) out.solana = this.solanaSigner().address;
    return out;
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

  /**
   * An UNSIGNED settlement transaction for one leg, built server-side. The same four handlers /v1
   * serves an API-key integrator, and the same ones the web app and the Mini App use — so the agent
   * signs bytes it did not assemble, and no program IDL lives in this package.
   */
  buildLeg = (id: string, leg: 'a' | 'b', action: 'fund' | 'claim' | 'refund', body: Record<string, unknown> = {}) =>
    this.req<SolanaLegTx>(`/swaps/${id}/legs/${leg}/${action}`, { body });
  broadcastSigned = (chain: 'evm' | 'tron' | 'bitcoin' | 'solana', signed: unknown) =>
    this.req<{ txid: string }>('/swaps/tx/broadcast', { body: { chain, signed } });
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
