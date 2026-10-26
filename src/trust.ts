import { createPublicClient, http } from 'viem';
import type { HashlockClient, Swap } from './client.js';
import { BITCOIN, EVM, MAX_FEE_BPS, MAX_TIMELOCK_SECONDS, NATIVE_SYMBOL, SOLANA, SOLANA_GENESIS, TRON, TRON_GENESIS, type Net, type Rail } from './pinned.js';
import type { AgreementStore, AssetSnapshot } from './secrets.js';

/**
 * THE ONE RULE OF TESTER 3.4: the agent never signs, funds or reveals a secret on the API's data alone.
 * This file is where API data meets what the agent knows for itself:
 *  - WHICH NETWORK a chain is, from the agent's own RPC (never /config), and what is pinned there;
 *  - WHICH ASSET a leg is in, as the agent recorded it when it agreed, and only if it is pinned;
 *  - WHAT WAS AGREED — side, assets, amounts — against the swap row, plus a ceiling on fee and timelock.
 * Every settlement path calls these; none re-derives them.
 */

type Leg = 'a' | 'b';

/** A chain resolved through the agent's own endpoint: its pinned rail and the identifiers it answers with. */
export interface EvmNet {
  rail: Rail;
  chainId: number;
  rpcUrl: string;
  /** The factory /config names — pinned-checked by the caller that sends money through it. */
  factory: `0x${string}`;
}

const cache = new Map<string, Promise<unknown>>();
function once<T>(key: string, get: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, get().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key) as Promise<T>;
}

/** An EVM chain as the agent's own RPC answers for it — the chain id the pins are keyed by. */
export async function evmNet(api: HashlockClient, chain: string): Promise<EvmNet> {
  const c = await api.evmChain(chain);
  const chainId = await once(`evm:${c.rpcUrl}`, () => createPublicClient({ transport: http(c.rpcUrl) }).getChainId());
  if (chainId !== c.chainId) throw new Error(`your RPC for ${chain} answers for chain ${chainId}, but the API calls it ${c.chainId}`);
  const rail = EVM[chainId];
  if (!rail) throw new Error(`chain id ${chainId} is not one this release settles on — upgrade @hashlock-tech/mcp`);
  return { rail, chainId, rpcUrl: c.rpcUrl, factory: c.factory };
}

/** TRON mainnet or Nile, by the genesis block of the agent's own TRON host. */
export async function tronNet(api: HashlockClient): Promise<{ net: Net; rail: Rail }> {
  const { fullHost, apiKey } = await api.tronChain();
  const net = await once(`tron:${fullHost}`, async () => {
    const res = await fetch(`${fullHost}/wallet/getblockbynum`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) },
      body: JSON.stringify({ num: 0 }),
    });
    const id = ((await res.json()) as { blockID?: string }).blockID ?? '';
    const n = TRON_GENESIS[id];
    if (!n) throw new Error(`the TRON host ${fullHost} is not a network this release settles on (genesis ${id || 'unknown'})`);
    return n;
  });
  return { net, rail: TRON[net] };
}

/** Solana mainnet or devnet, by the genesis hash of the agent's own Solana RPC. */
export async function solanaNet(api: HashlockClient): Promise<{ net: Net; rail: Rail }> {
  const rpc = api.solanaRpc;
  const net = await once(`svm:${rpc}`, async () => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }),
    });
    const hash = ((await res.json()) as { result?: string }).result ?? '';
    const n = SOLANA_GENESIS[hash];
    if (!n) throw new Error(`the Solana RPC ${rpc} is not a cluster this release settles on (genesis ${hash || 'unknown'}) — set HASHLOCK_SOLANA_RPC`);
    return n;
  });
  return { net, rail: SOLANA[net] };
}

/**
 * Bitcoin's network is the one the agent's OWN key is for — its WIF carries it, and BtcSigner refuses a
 * /config network that disagrees — plus the local Esplora and the pinned treasury for that network.
 */
export async function btcNet(api: HashlockClient): Promise<{ net: Net; network: string; esplora: string; treasury: string; confirmations: number }> {
  const signer = await api.btcSigner();
  const net: Net = signer.address.startsWith('bc1') ? 'mainnet' : 'testnet';
  const network = net === 'mainnet' ? 'mainnet' : 'signet';
  return { net, network, esplora: api.btcEsplora(network), ...BITCOIN[net] };
}

/**
 * The token a leg settles in on `rail`: null for the native coin, else its address — only if pinned. A
 * registry row that is neither native nor has an address is refused everywhere: settling it as the native
 * coin is how a broken token row becomes a payment in the wrong currency.
 */
export function pinnedToken(rail: Rail, asset: AssetSnapshot, family: 'evm' | 'tron' | 'svm'): string | null {
  if (asset.isNative) {
    if (asset.symbol !== NATIVE_SYMBOL[family]) throw new Error(`the registry calls the native coin "${asset.symbol}", but it is ${NATIVE_SYMBOL[family]} — refusing`);
    return null;
  }
  if (!asset.address) throw new Error(`asset ${asset.id} on ${asset.chain} is neither native nor has a token address — refusing to settle it`);
  const key = family === 'evm' ? asset.address.toLowerCase() : asset.address;
  const pinned = rail.tokens[key];
  if (!pinned) {
    throw new Error(`${asset.address} on ${asset.chain} is not an asset this release settles in — settle it with your own wallet, or upgrade @hashlock-tech/mcp`);
  }
  if (pinned.symbol !== asset.symbol) throw new Error(`the registry calls ${asset.address} "${asset.symbol}", but it is ${pinned.symbol} — refusing`);
  return key;
}

export function assertPinned(list: readonly string[], address: string, what: string, evm = false): void {
  const norm = (a: string) => (evm ? a.toLowerCase() : a);
  if (!list.some((x) => norm(x) === norm(address))) {
    throw new Error(`refusing: ${address} is not ${what} this release knows on that network — upgrade @hashlock-tech/mcp if Hashlock rotated it`);
  }
}

/** A deal the agent has checked against what it agreed: which leg is whose and what each is in. */
export interface Deal {
  side: 'maker' | 'taker';
  /** The leg the agent gives (funds) and the one it receives (claims). */
  mine: Leg;
  theirs: Leg;
  /** Each leg's asset as the agent saw it when it agreed. */
  asset: Record<Leg, AssetSnapshot>;
}

/**
 * THE SWAP IS WHAT THE AGENT AGREED TO. The side, both legs' assets and chains, the base amount and a price
 * the agent put its name to must all match the swap row; the fee may only be on the taker's leg and under
 * the pinned ceiling; no leg may be locked longer than the pinned ceiling. A deal with no local record —
 * agreed through another client, or before this release — is not settled autonomously.
 */
export async function checkDeal(api: HashlockClient, swap: Swap, agreements: Pick<AgreementStore, 'get'>): Promise<Deal> {
  const rfqId = typeof swap.rfqId === 'string' ? swap.rfqId : '';
  const ag = rfqId ? agreements.get(rfqId) : null;
  if (!ag) {
    throw new Error('this process has no record of agreeing to this deal — settle it with your own wallet (autonomous settlement needs the deal agreed through this MCP)');
  }
  const me = (await api.me()).user?.id;
  if (!me || (ag.side === 'maker' ? swap.makerId : swap.takerId) !== me) {
    throw new Error(`this agent agreed as the ${ag.side}, but the swap names someone else on that side`);
  }
  // legA = what the maker gives: sell_base (the taker sells base) → the maker gives the quote asset.
  const makerGives = ag.direction === 'sell_base' ? ag.quote : ag.base;
  const makerWants = ag.direction === 'sell_base' ? ag.base : ag.quote;
  const quoteLeg: Leg = ag.direction === 'sell_base' ? 'a' : 'b';
  const amount = (l: Leg) => (l === 'a' ? swap.aAmount : swap.bAmount);
  const problems: string[] = [];
  if (swap.aAssetId !== makerGives.id || swap.aChain !== makerGives.chain) problems.push(`leg a is ${swap.aAssetId}@${swap.aChain}, not the agreed ${makerGives.id}@${makerGives.chain}`);
  if (swap.bAssetId !== makerWants.id || swap.bChain !== makerWants.chain) problems.push(`leg b is ${swap.bAssetId}@${swap.bChain}, not the agreed ${makerWants.id}@${makerWants.chain}`);
  if (amount(quoteLeg === 'a' ? 'b' : 'a') !== ag.baseAmount) problems.push(`the base leg is ${amount(quoteLeg === 'a' ? 'b' : 'a')}, not the agreed ${ag.baseAmount}`);
  // A price the agent agreed to in this very thread, or its private order's ask: one made in another thread is
  // not this deal.
  const agreed = [...(ag.prices[swap.threadId] ?? []), ...(ag.ask ? [ag.ask] : [])];
  if (!agreed.includes(amount(quoteLeg))) problems.push(`the quote leg is ${amount(quoteLeg)}, not a price this agent agreed to in this thread`);
  const fee = BigInt(swap.feeAmount || '0');
  if (fee > 0n && (swap.feeAssetId !== swap.bAssetId || fee * 10_000n > BigInt(swap.bAmount) * MAX_FEE_BPS)) {
    problems.push(`a protocol fee of ${fee} in ${swap.feeAssetId} is not one this release accepts (taker's leg, at most ${MAX_FEE_BPS} bps)`);
  }
  const latest = Math.floor(Date.now() / 1000) + MAX_TIMELOCK_SECONDS;
  for (const l of ['a', 'b'] as const) {
    const tl = Math.floor(Date.parse(l === 'a' ? swap.aTimelock : swap.bTimelock) / 1000);
    if (!Number.isFinite(tl) || tl > latest) problems.push(`leg ${l}'s timelock ${l === 'a' ? swap.aTimelock : swap.bTimelock} is missing or beyond ${MAX_TIMELOCK_SECONDS / 3600}h`);
  }
  if (problems.length) throw new Error(`refusing: the swap is not the deal this agent agreed to — ${problems.join('; ')}`);
  const mine: Leg = ag.side === 'maker' ? 'a' : 'b';
  return { side: ag.side, mine, theirs: mine === 'a' ? 'b' : 'a', asset: { a: makerGives, b: makerWants } };
}
