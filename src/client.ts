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
  solanaAddress: string | null;
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
  }

  private linkingSolana: Promise<void> | null = null;
  /** Settled outcome of the link attempt: done, or a permanent reason worth telling the agent. */
  private solanaLink: { done: true } | { failed: string } | null = null;
  /** Earliest a transient link failure may be retried — a 429 answered immediately makes itself true. */
  private linkRetryAfter = 0;
  /**
   * The last TRANSIENT reason, kept apart from the settled one because the two say different things to
   * an agent: settled means stop asking, transient means it will be tried again. Nothing recorded this
   * before, so the commonest failure explained nothing — and the 429 floor made that sharpest, since for
   * thirty seconds ensureSolanaLinked returns without attempting and the agent met the server's bare
   * "prove ownership of your Solana wallet", which is precisely what this client was backing off from.
   */
  private solanaLinkRetry: string | null = null;
  /**
   * Prove the agent owns its Solana wallet, so the account row carries the address.
   *
   * Signing is not enough on its own: rfq/service.ts refuses to create an order whose GIVE leg is
   * Solana unless users.solanaAddress is set, and setSwapAddress writes the address book, not that
   * column. Without this the agent could only ever be the taker on a Solana pair — half a rail.
   *
   * Called where it is NEEDED rather than after login: HASHLOCK_TOKEN is a first-class auth mode, and
   * with it login() never runs, so a hook there covered the one path that needs no help.
   */
  /**
   * NEVER THROWS. A Solana wallet that cannot be linked must not stop the agent trading anything else —
   * an earlier version raised the failure from every call site, so one typo in HASHLOCK_SOLANA_KEY, or
   * an account already linked to the user's own Phantom, blocked posting, quoting and accepting on
   * BTC↔EVM too. The outcome is RECORDED and reported by whoami instead, which is where an agent looks
   * when something it did not ask about is wrong.
   */
  async ensureSolanaLinked(): Promise<void> {
    if (!this.cfg.solanaKey || (this.solanaLink && 'done' in this.solanaLink)) return;
    if (Date.now() < this.linkRetryAfter) return;
    this.linkingSolana ??= (async () => {
      // A BAD KEY IS SETTLED, and it is separated out here rather than classified below: it throws from
      // our own constructor, not from the network, so the retry question does not apply to it. Lumped in
      // with the remote failures it looked retryable and re-ran a nonce fetch on every call, for ever,
      // while never being reported.
      let signer: SolanaSigner;
      try {
        signer = this.solanaSigner();
      } catch (e) {
        this.solanaLink = { failed: `unusable HASHLOCK_SOLANA_KEY: ${(e as Error).message}` };
        this.solanaLinkRetry = null; // settled clears transient, on EVERY settled path and not just one
        return;
      }
      try {
        await this.linkSolanaOnce(signer);
        this.solanaLink = { done: true };
        this.solanaLinkRetry = null;
      } catch (e) {
        // RETRY unless the server gave a definitive answer. `fetch failed` is a plain TypeError, not an
        // ApiError, and a 429 is a "come back later" — treating either as settled cached a one-second
        // blip as permanent for the life of the process.
        const settled = e instanceof ApiError && e.status < 500 && e.status !== 429;
        if (settled) {
          this.solanaLink = { failed: (e as Error).message };
          this.solanaLinkRetry = null; // a settled answer replaces whatever the earlier attempts said
        } else {
          this.solanaLinkRetry = (e as Error).message;
          this.linkingSolana = null;
          // The floor is for a 429 ONLY. Answering a rate limiter on the very next call is what makes
          // its verdict true; a dropped connection deserves the opposite — the next call should just try.
          if (e instanceof ApiError && e.status === 429) this.linkRetryAfter = Date.now() + 30_000;
        }
      }
    })();
    await this.linkingSolana;
  }

  /**
   * Whether the Solana wallet held here is proven to the account — derived from the ACCOUNT, not from
   * what this process happened to attempt. Reading it off the attempt meant the steady state, where the
   * wallet is already linked and so no attempt is ever made, reported "not attempted yet" for ever; and
   * the conflict with a wallet linked elsewhere was never reported at all, because the only code that
   * builds that sentence runs inside an attempt that never happens.
   */
  solanaLinkStatus(user?: User | null): string | undefined {
    if (!this.cfg.solanaKey) return undefined;
    let mine: string;
    try {
      mine = this.solanaSigner().address;
    } catch (e) {
      return `unusable HASHLOCK_SOLANA_KEY: ${(e as Error).message}`;
    }
    const linked = user?.solanaAddress ?? null;
    if (linked === mine) return 'linked';
    if (linked) return `this account is linked to Solana wallet ${linked}, not ${mine} — the existing link is left alone`;
    if (this.solanaLink && 'done' in this.solanaLink) return 'linked';
    // A row that says "unlinked" is the ACCOUNT talking, and it outranks anything cached here: a 409
    // recorded at start-up is settled for the life of the process, so after the user unlinks that wallet
    // in the web app the cache would have reported a conflict alongside a solanaAddress of null — one
    // payload contradicting itself, and no retry. Only speak from the cache when no row was passed.
    if (user) return this.notLinkedYet();
    if (this.solanaLink && 'failed' in this.solanaLink) return this.solanaLink.failed;
    return this.notLinkedYet();
  }

  /** "Not linked yet" WITH the last transient reason, if there was one, and whether a retry is being
   *  held off. Saying only "not linked yet" while a 429 floor is in force reads as "nothing is
   *  happening" when the truth is "we are waiting on purpose, until a moment I can name". */
  private notLinkedYet(): string {
    if (!this.solanaLinkRetry) return 'not linked yet';
    const waitMs = this.linkRetryAfter - Date.now();
    const when = waitMs > 0 ? `retrying in ${Math.ceil(waitMs / 1000)}s` : 'the next call will retry';
    return `not linked yet — last attempt failed: ${this.solanaLinkRetry} (${when})`;
  }

  /**
   * Run a request, and if it fails for a reason the Solana link would explain, say what that reason was.
   * Not throwing the link failure is right — it must not block chains it has nothing to do with — but
   * dropping it left the agent with the server's generic "prove ownership of your Solana wallet", which
   * tells it to do the very thing this client already tried and recorded a reason for declining.
   */
  private async withSolanaReason<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Settled first — though the two are mutually exclusive by construction rather than by this
      // order: every path that records a settled failure clears the transient one, and once settled no
      // further attempt runs to set it again. The order says which would win if that ever stopped being
      // true; it is not resolving a contest that can happen today.
      //
      // The transient case reuses notLinkedYet() instead of building a second sentence, because the
      // first version of it dropped the one thing this change added — a 429 said "the Solana wallet is
      // not linked: slow down" and never mentioned that a retry was already scheduled.
      const reason =
        this.solanaLink && 'failed' in this.solanaLink
          ? this.solanaLink.failed
          : this.solanaLinkRetry
            ? this.notLinkedYet()
            : null;
      // Matched on the messages the server ACTUALLY sends, not on the word "solana": only
      // assertOwnsGiveFamily names the chain. A refused quote says "insufficient SOL: …" and a refused
      // private order says "reserved for a specific wallet — prove ownership of that address", so the
      // wrapper was dead on two of its three call sites.
      if (reason && /prove ownership|reserved for a specific wallet|insufficient SOL\b/i.test((e as Error).message)) {
        // 502, not 400: a cause that is not an ApiError is a transport failure, and presenting that as a
        // client error tells the agent a retryable problem is permanent.
        throw new ApiError(`${(e as Error).message} — ${reason}`, e instanceof ApiError ? e.status : 502);
      }
      throw e;
    }
  }

  private async linkSolanaOnce(s: SolanaSigner): Promise<void> {
    // Read the profile directly, not through me(): me() calls ensureSolanaLinked, and going back through
    // it here would leave this awaiting the promise it is itself running.
    const me = (await this.req<{ user: User | null }>('/me')).user;
    if (me?.solanaAddress === s.address) return; // already ours
    if (me?.solanaAddress) {
      // NEVER overwrite. /me/link-solana 409s only for ANOTHER account's wallet; for this account it
      // reassigns the column unconditionally — which would silently replace a Phantom wallet the user
      // linked in the web app with the agent's key, and then refuse their next order for a balance the
      // agent does not have. me.ts warns about exactly this on its own passive-sync path.
      throw new ApiError(
        `this account is linked to Solana wallet ${me.solanaAddress}, not the agent's ${s.address} — the existing link is left alone`,
        409,
      );
    }
    const { nonce } = await this.req<{ nonce: string }>('/auth/siwe/nonce', { auth: false });
    const message = `Hashlock Markets wants you to sign in.\n\nAddress: ${s.address}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    await this.req('/me/link-solana', { body: { address: s.address, message, signature: s.signLoginMessage(message) } });
  }

  /**
   * The addresses this process can actually sign for, whatever the account row says. Async because the
   * BTC signer needs the network from /config — and leaving Bitcoin out for that reason would have made
   * an agent holding HASHLOCK_BTC_KEY fall back to the account's address, which may be an embedded
   * wallet it has no key for, and build a BTC leg it cannot sign.
   *
   * A bad key is reported per family rather than thrown: whoami is the tool an agent calls to check its
   * auth, and one malformed key should not turn that answer into an error envelope.
   */
  async localSigners(): Promise<{ addresses: Record<string, string>; unusable?: Record<string, string> }> {
    const addresses: Record<string, string> = {};
    const unusable: Record<string, string> = {};
    // Failures go in their OWN field. An agent reads this map to pick a settlement address, and an
    // error string sitting where an address belongs passes a truthiness check and gets submitted.
    const put = async (name: string, get: () => string | Promise<string>) => {
      try {
        addresses[name] = await get();
      } catch (e) {
        // btc resolves its network through /config, so an API outage lands here for a perfectly good
        // key — which is why this says "could not be read", not "bad key".
        unusable[name] = `could not be read: ${(e as Error).message}`;
      }
    };
    if (this.cfg.evmKey) await put('evm', () => this.evmSigner().address);
    if (this.cfg.tronKey) await put('tron', () => this.tronSigner().address);
    if (this.cfg.solanaKey) await put('solana', () => this.solanaSigner().address);
    if (this.cfg.btcKey) await put('btc', async () => (await this.btcSigner()).address);
    return Object.keys(unusable).length ? { addresses, unusable } : { addresses };
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
  /**
   * The account, and the last place the Solana link can be established for an agent that neither posts
   * an order nor quotes: users.solanaAddress is what puts it in the feed for a private order aimed at
   * its Solana wallet, and what lets it answer one. Best-effort here — whoami must still answer when
   * the link cannot be made, and the reason reaches the agent through `solanaLink`.
   *
   * `link: false` for a caller that has ALREADY awaited ensureSolanaLinked — whoami does. Without it
   * that sequence started a SECOND attempt: the awaited one fails transiently, which nulls linkingSolana
   * and records no address, so this line sees a falsy solanaAddress and fires again un-awaited — and
   * whoami then answers "not linked yet" while that attempt is still in flight, so a success a moment
   * later is never in the reply the agent already has.
   */
  me = async (opts: { link?: boolean } = {}) => {
    const res = await this.req<{ user: User | null }>('/me');
    // Kicked off, not awaited: whoami stays a read, and the link still lands for an agent that only ever
    // receives private orders — users.solanaAddress is what ownedAddresses puts them in the feed by.
    // Explicitly caught, not merely `void`: "never throws" is a contract this file keeps by inspection,
    // and an unhandled rejection here takes the stdio server down rather than one tool call.
    if (opts.link !== false && this.cfg.solanaKey && res.user && !res.user.solanaAddress) {
      void this.ensureSolanaLinked().catch(() => {});
    }
    return res;
  };
  listRfqs = (q: { baseAssetId?: string; quoteAssetId?: string; direction?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return this.req<{ rfqs: Rfq[] }>(`/rfqs${qs.size ? `?${qs}` : ''}`, { auth: false });
  };
  getRfq = (id: string) => this.req<{ rfq: Rfq }>(`/rfqs/${id}`, { auth: false });
  createRfq = async (body: Record<string, unknown>) => {
    await this.ensureSolanaLinked();
    return this.withSolanaReason(() => this.req<{ rfq: Rfq }>('/rfqs', { body }));
  };
  cancelRfq = (id: string) => this.req<{ rfq: Rfq }>(`/rfqs/${id}/cancel`, { body: {} });
  postQuote = async (id: string, quoteAmount: string) => {
    await this.ensureSolanaLinked();
    return this.withSolanaReason(() => this.req<{ quote: unknown; thread: Thread }>(`/rfqs/${id}/quotes`, { body: { quoteAmount } }));
  };

  getThread = (id: string) =>
    this.req<{ thread: Thread; rfq: Rfq; messages: Message[]; swap: Swap | null }>(`/threads/${id}`);
  postMessage = (id: string, body: string) => this.req(`/threads/${id}/messages`, { body: { body } });
  propose = (id: string, quoteAmount: string) =>
    this.req<{ thread: Thread }>(`/threads/${id}/propose`, { body: { quoteAmount } });
  acceptProposal = (id: string) => this.req<{ thread: Thread }>(`/threads/${id}/accept-proposal`, { body: {} });
  accept = async (id: string, hashlock?: string) => {
    await this.ensureSolanaLinked();
    return this.withSolanaReason(() =>
      this.req<{ thread: Thread; swap?: Swap }>(`/threads/${id}/accept`, { body: hashlock ? { hashlock } : {} }),
    );
  };
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
