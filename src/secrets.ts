import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Local store for atomic-swap secrets (preimages). The secret is generated HERE, on the agent's
 * machine, and never sent to the API — only its sha256 (the hashlock) is. The initiator needs the
 * preimage later to claim their receive leg, so it persists keyed by threadId (same convention as
 * the web app's localStorage `hl.secret.<threadId>`). Format matches the whole stack: bare hex,
 * 32 bytes, sha256 hashlock (Bitcoin Script compatible).
 */
export interface StoredSecret {
  secret: string; // 64-char hex preimage — keep private
  hashlock: string; // sha256(secret), 64-char hex
  createdAt: string;
  /** The request this secret's deal is on — a swap is unlocked with it only if it is on the same one. */
  rfqId?: string;
  /** Set once the preimage has left this store (a claim, or get_deal_secret): it is public from then on. */
  revealedAt?: string;
  /** The swap the agent funded its leg of under this hashlock: no other swap may use it. */
  fundedFor?: string;
  /** Earlier secrets of this thread, replaced after they were revealed — kept, as a claim may still need one. */
  previous?: StoredSecret[];
}

/** Hex as the whole stack compares it: no 0x, lower-case. */
export const normHex = (hex: string): string => hex.replace(/^0x/i, '').toLowerCase();
/** sha256 of a hex preimage, as hex — how every rail derives the hashlock. */
export const sha256Hex = (hex: string): string => createHash('sha256').update(Buffer.from(normHex(hex), 'hex')).digest('hex');

/**
 * Read a JSON store. A file that does not parse is an ERROR, not an empty store: treating it as empty made
 * the next save overwrite every preimage in it, and a lost preimage is a leg the initiator cannot claim.
 */
function readJson<T>(path: string, empty: T): T {
  if (!existsSync(path)) return empty;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    throw new Error(`${path} is not readable JSON (${(e as Error).message}) — fix or restore it; it is not overwritten`);
  }
}

/** Write through a temp file and a rename, so a crash mid-write leaves the old file whole. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export class SecretStore {
  constructor(private readonly path: string) {}

  private load(): Record<string, StoredSecret> {
    return readJson<Record<string, StoredSecret>>(this.path, {});
  }

  private save(all: Record<string, StoredSecret>): void {
    writeJson(this.path, all);
  }

  /**
   * Generate (or return the existing) secret for a thread. Idempotent per thread — until the secret has
   * been revealed: a reopened thread must not agree a new deal under a hashlock that is already public.
   */
  generate(threadId: string, rfqId: string): StoredSecret {
    const all = this.load();
    const existing = all[threadId];
    if (existing && existing.rfqId && existing.rfqId !== rfqId) {
      throw new Error(`thread ${threadId} is on request ${existing.rfqId}, not ${rfqId}`);
    }
    // A secret is reused only while nothing has been done with it: once revealed, or once a leg was funded
    // under it, a reopened thread's next deal gets a fresh one.
    // A secret from before this release (no rfqId) may have been handed out by the old status-only gate:
    // it is treated like a revealed one.
    if (existing && existing.rfqId && !existing.revealedAt && !existing.fundedFor) return existing;
    const secret = randomBytes(32).toString('hex');
    const hashlock = sha256Hex(secret);
    const entry: StoredSecret = { secret, hashlock, createdAt: new Date().toISOString(), rfqId };
    if (existing) {
      const { previous = [], ...old } = existing;
      entry.previous = [...previous, old];
    }
    all[threadId] = entry;
    this.save(all);
    return entry;
  }

  get(threadId: string): StoredSecret | null {
    return this.load()[threadId] ?? null;
  }

  /** Every thread's secret, current and earlier, that opens `hashlock` — wherever the API says the swap is. */
  findByHashlock(hashlock: string): { threadId: string; entry: StoredSecret } | null {
    for (const [threadId, e] of Object.entries(this.load())) {
      const hit = [e, ...(e.previous ?? [])].find((x) => x.hashlock === hashlock);
      if (hit) return { threadId, entry: hit };
    }
    return null;
  }

  /** The entry of `threadId` — current or earlier — whose hashlock is `hashlock`. */
  private entryOf(all: Record<string, StoredSecret>, threadId: string, hashlock: string): StoredSecret | undefined {
    const e = all[threadId];
    return e && [e, ...(e.previous ?? [])].find((x) => x.hashlock === hashlock);
  }

  /** Record that this thread's secret for `hashlock` now locks the agent's leg of `swapId`. */
  markFunded(threadId: string, hashlock: string, swapId: string): void {
    const all = this.load();
    const entry = this.entryOf(all, threadId, hashlock);
    if (!entry || entry.fundedFor === swapId) return;
    if (entry.fundedFor) throw new Error(`this thread's secret already locks swap ${entry.fundedFor}`);
    entry.fundedFor = swapId;
    this.save(all);
  }

  /** Record that the preimage is out, so nothing is ever locked under it again (tester 3.4). */
  markRevealed(threadId: string, hashlock?: string): void {
    const all = this.load();
    const entry = hashlock ? this.entryOf(all, threadId, hashlock) : all[threadId];
    if (!entry || entry.revealedAt) return;
    entry.revealedAt = new Date().toISOString();
    this.save(all);
  }
}

/** An asset as the agent saw it when it agreed: what the deal is in, whatever the registry says later. */
export interface AssetSnapshot {
  id: string;
  /** The symbol the agent was shown — it must be the pinned token's, or the asset is not what it looks like. */
  symbol: string;
  chain: string;
  address: string | null;
  isNative: boolean;
}

/**
 * WHAT THIS AGENT AGREED TO, recorded when it agreed (tester 3.4): the side it took — taker on a request it
 * created here, maker on one it quoted here, never the API's say-so — the request's assets and base amount
 * as it saw them, and per deal thread every total price it put its name to (a quote, a counter, an accept).
 * A private order's ask counts in any thread. Settlement compares the swap the API reports against this, so
 * a swap row rewritten afterwards — another amount, another asset, the other side, a price the agent never
 * agreed to in that thread — is refused rather than funded.
 */
export interface Agreement {
  side: 'maker' | 'taker';
  direction: 'sell_base' | 'buy_base';
  base: AssetSnapshot;
  quote: AssetSnapshot;
  baseAmount: string;
  /** The private order's fixed price (taker only). */
  ask?: string;
  /** threadId → every price this agent agreed to in it. */
  prices: Record<string, string[]>;
}

/** A settlement address this MCP set for a swap, recorded once the API took it. */
export interface SetAddress {
  chain: string;
  /** The leg it was set for when the caller named one (both legs on one chain). */
  leg?: 'a' | 'b';
  address: string;
  threadId: string;
  hashlock: string;
}

interface AgreementFile {
  agreements: Record<string, Agreement>;
  /** Escrow → the swap the agent relied on it for: one escrow never backs two deals. */
  relied: Record<string, string>;
  /** swapId → the addresses this agent itself set on it: the only recipients besides its own keys it trusts. */
  addresses: Record<string, SetAddress[]>;
}

export class AgreementStore {
  constructor(private readonly path: string) {}

  /** Next to the secrets file: `mcp-secrets.json` → `mcp-secrets.agreements.json`. */
  static besides(secretsPath: string): AgreementStore {
    return new AgreementStore(`${secretsPath.replace(/\.json$/, '')}.agreements.json`);
  }

  private load(): AgreementFile {
    const f = readJson<Partial<AgreementFile>>(this.path, {});
    return { agreements: f.agreements ?? {}, relied: f.relied ?? {}, addresses: f.addresses ?? {} };
  }

  get(rfqId: string): Agreement | null {
    return this.load().agreements[rfqId] ?? null;
  }

  /** Record a request this agent created here (the taker side), with its ask if it has one. */
  create(rfqId: string, terms: Omit<Agreement, 'prices' | 'side'>): void {
    const f = this.load();
    if (f.agreements[rfqId]) throw new Error(`request ${rfqId} is already recorded`);
    f.agreements[rfqId] = { ...terms, side: 'taker', prices: {} };
    writeJson(this.path, f);
  }

  /**
   * Record agreeing to `price` (base units of the quote asset) in `threadId`. `terms` (the maker side) is
   * used only for a request not recorded yet — one this agent is quoting; a request recorded before must
   * still have those terms, or it is not the one the agent agreed to.
   */
  agree(rfqId: string, threadId: string, price: string, terms?: Omit<Agreement, 'prices' | 'ask'>): void {
    const f = this.load();
    const had = f.agreements[rfqId];
    if (!had && !terms) {
      throw new Error(`request ${rfqId} was not created or quoted through this MCP — agree to it with your own wallet's app`);
    }
    if (had && terms) {
      const same = (a: AssetSnapshot, b: AssetSnapshot) =>
        a.id === b.id && a.symbol === b.symbol && a.chain === b.chain && (a.address ?? '').toLowerCase() === (b.address ?? '').toLowerCase() && a.isNative === b.isNative;
      if (had.side !== terms.side || had.direction !== terms.direction || had.baseAmount !== terms.baseAmount || !same(had.base, terms.base) || !same(had.quote, terms.quote)) {
        throw new Error(`request ${rfqId} no longer has the terms this agent recorded for it — refusing to agree`);
      }
    }
    const rec = had ?? { ...terms!, prices: {} };
    rec.prices[threadId] = [...new Set([...(rec.prices[threadId] ?? []), price])];
    f.agreements[rfqId] = rec;
    writeJson(this.path, f);
  }

  /**
   * Take `key` once: the first call records it, every later one is refused. A swap's own leg is funded by
   * this process at most once — whatever terms the API reports on a retry, since a changed term is a new
   * escrow address that no on-chain "already funded" check would find.
   */
  takeOnce(key: string, what: string): void {
    const f = this.load();
    if (f.relied[key]) throw new Error(`${what} was already sent once (${f.relied[key]}) — check the chain, or settle it in the web app`);
    f.relied[key] = new Date().toISOString();
    writeJson(this.path, f);
  }

  /**
   * Record an address this agent set on `swapId` — called only after the API took it, so no record ever
   * names an address the swap never carried. The agent chose it, so an escrow paying it pays the agent.
   */
  recordAddress(swapId: string, rec: SetAddress): void {
    const f = this.load();
    const list = f.addresses[swapId] ?? [];
    // The LATEST address per chain and leg wins — a record naming no leg and one naming a leg replace each
    // other — so one the agent corrected away is no longer trusted.
    const chain = rec.chain.trim().toLowerCase();
    const replaces = (r: SetAddress) => r.chain === chain && (r.leg === undefined || rec.leg === undefined || r.leg === rec.leg);
    f.addresses[swapId] = [...list.filter((r) => !replaces(r)), { ...rec, chain }];
    writeJson(this.path, f);
  }

  /** The addresses this agent set on `swapId` for `chain` — for `leg`, when one was named. */
  addressesFor(swapId: string, chain: string, leg: 'a' | 'b'): string[] {
    const c = chain.trim().toLowerCase();
    return (this.load().addresses[swapId] ?? []).filter((r) => r.chain === c && (r.leg === undefined || r.leg === leg)).map((r) => r.address);
  }

  /**
   * Record that the agent relies on `key` for `swapId` — an escrow it is paid from, or a hashlock it funds
   * under; refuses one already relied on for another swap. One escrow pays one deal; one hashlock locks one
   * leg of the agent's, or revealing it to claim one deal would open the other too.
   */
  rely(escrow: string, swapId: string): void {
    const f = this.load();
    const had = f.relied[escrow];
    if (had && had !== swapId) throw new Error(`escrow ${escrow} already backs swap ${had} — one escrow cannot pay two deals`);
    if (had) return;
    f.relied[escrow] = swapId;
    writeJson(this.path, f);
  }
}
