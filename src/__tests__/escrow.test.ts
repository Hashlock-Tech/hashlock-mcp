import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BtcSigner, htlcScript, readBtcEscrow } from '../chains/btc.js';
import { HTLC_INSTRUCTIONS, SolanaSigner, base58Decode, base58Encode, decodeSolanaEscrow, solanaAccountExists, type SolanaPin } from '../chains/solana.js';
import type { HashlockClient, Swap } from '../client.js';
import { BITCOIN, EVM, TRON, pinnedAsset } from '../pinned.js';
import { AgreementStore, SecretStore, type Agreement, type AssetSnapshot } from '../secrets.js';
import { claimMyLeg, escrowProblem, fundMyLeg, MIN_TIMELOCK_GAP_SECONDS, releaseOwnSecret, type OnchainEscrow } from '../settlement.js';
import { assertPinned, checkDeal, evmNet, pinnedToken, solanaNet, tronNet } from '../trust.js';

/**
 * Tester 3.4 — the agent never signs, funds or reveals a secret on the API's data alone. One test group per
 * rule: pins per network, the deal as agreed, the escrow on chain, every server-built transaction decoded,
 * and the one gate a secret leaves through.
 */

const H = 'ab'.repeat(32);
const TL = 1893456000;
const SWAP_ID = '0f8e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
afterEach(() => vi.restoreAllMocks());

const tmpStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-'));
  return { secrets: new SecretStore(join(dir, 's.json')), agreements: AgreementStore.besides(join(dir, 's.json')) };
};

/** One fetch double for every endpoint a test touches: EVM JSON-RPC, TRON/Solana genesis, Esplora. */
function net(routes: {
  evmChainId?: number;
  /** eth_getCode answer for any address: '0x' = no contract there. */
  evmCode?: string;
  tronGenesis?: string;
  solanaGenesis?: string;
  solanaAccount?: boolean;
  esplora?: { confirmed: number; depth?: number; mempool?: number; spent?: number };
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (body?.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: body.id, result: `0x${(routes.evmChainId ?? 1).toString(16)}` });
    if (body?.method === 'eth_call') return json({ jsonrpc: '2.0', id: body.id, result: `0x${'00'.repeat(12)}${'99'.repeat(20)}` });
    if (body?.method === 'eth_getCode') return json({ jsonrpc: '2.0', id: body.id, result: routes.evmCode ?? '0x' });
    if (body?.method === 'getGenesisHash') return json({ jsonrpc: '2.0', id: 1, result: routes.solanaGenesis });
    if (body?.method === 'getAccountInfo') return json({ jsonrpc: '2.0', id: 1, result: { value: routes.solanaAccount ? { owner: 'x', data: ['', 'base64'] } : null } });
    if (url.endsWith('/wallet/getblockbynum')) return json({ blockID: routes.tronGenesis });
    const e = routes.esplora ?? { confirmed: 0 };
    if (url.endsWith('/blocks/tip/height')) return new Response('1000');
    if (url.endsWith('/utxo')) {
      const list = [];
      if (e.confirmed) list.push({ txid: '00'.repeat(32), vout: 0, value: e.confirmed, status: { confirmed: true, block_height: 1000 - (e.depth ?? 10) + 1 } });
      if (e.mempool) list.push({ txid: '11'.repeat(32), vout: 0, value: e.mempool, status: { confirmed: false } });
      return json(list);
    }
    if (/\/address\/[^/]+$/.test(url)) {
      return json({
        chain_stats: { funded_txo_sum: e.confirmed + (e.spent ?? 0), spent_txo_sum: e.spent ?? 0 },
        mempool_stats: { funded_txo_sum: e.mempool ?? 0, spent_txo_sum: 0 },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// ── escrowProblem ────────────────────────────────────────────────────────────
const ok: OnchainEscrow = { hashlock: H, recipient: 'me', token: null, amount: 100n, timelock: 5000, open: true };
const want = { hashlock: H, recipients: ['me', 'my-set-address'], token: null, amount: 100n, minTimelock: 5000 };

describe('escrowProblem', () => {
  it('accepts the agreed escrow, and one holding more than agreed', () => {
    expect(escrowProblem(ok, want)).toBeNull();
    expect(escrowProblem({ ...ok, amount: 101n }, want)).toBeNull();
    expect(escrowProblem({ ...ok, recipient: 'my-set-address' }, want)).toBeNull();
  });
  it('refuses every term that differs, and a deadline it cannot judge', () => {
    expect(escrowProblem({ ...ok, open: false }, want)).toMatch(/claimed or refunded/);
    expect(escrowProblem({ ...ok, hashlock: 'cd'.repeat(32) }, want)).toMatch(/hashlock/);
    expect(escrowProblem({ ...ok, recipient: 'attacker' }, want)).toMatch(/pays attacker/);
    expect(escrowProblem({ ...ok, token: 'T' }, want)).toMatch(/holds T/);
    expect(escrowProblem({ ...ok, amount: 99n }, want)).toMatch(/less than/);
    expect(escrowProblem({ ...ok, timelock: 4999 }, want)).toMatch(/expires/);
    expect(escrowProblem(ok, { ...want, minTimelock: NaN })).toMatch(/cannot be judged/);
  });
});

// ── pins, per network ────────────────────────────────────────────────────────
describe('pins: contracts and assets per network', () => {
  const asset = (address: string | null, isNative = false, symbol = isNative ? 'ETH' : 'USDT'): AssetSnapshot => ({ id: 'x', symbol, chain: 'ethereum', address, isNative });

  it('settles only in pinned tokens or the native coin, and refuses a token row with no address', () => {
    expect(pinnedToken(EVM[1]!, asset(null, true), 'evm')).toBeNull();
    expect(pinnedToken(EVM[1]!, asset('0xdAC17F958D2ee523a2206206994597C13D831ec7'), 'evm')).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7');
    // The Sepolia USDT is not mainnet USDT: an address is pinned on its network only.
    expect(() => pinnedToken(EVM[1]!, asset('0x14E932194809eDF8a0BD1F98B99F6A85845A20A4'), 'evm')).toThrow(/not an asset this release settles in/);
    expect(() => pinnedToken(EVM[1]!, asset(null), 'evm')).toThrow(/neither native nor has a token address/);
  });

  it('refuses a registry symbol that is not the pinned one — the symbol is what the agent decides on', () => {
    expect(() => pinnedToken(EVM[1]!, asset('0xdAC17F958D2ee523a2206206994597C13D831ec7', false, 'WBTC'), 'evm')).toThrow(/but it is USDT/);
    expect(() => pinnedToken(EVM[1]!, asset(null, true, 'WBTC'), 'evm')).toThrow(/but it is ETH/);
    expect(() => pinnedAsset('evm', '0xdac17f958d2ee523a2206206994597c13d831ec7', 'WBTC')).toThrow(/but it is USDT/);
  });

  it('funds only through current contracts and reads through retired ones too', () => {
    const retired = '0x0e4565a5d87f5ab61074D1bD019630ef6555D726';
    expect(() => assertPinned(EVM[11155111]!.fund, retired, 'an HTLC factory', true)).toThrow(/not an HTLC factory this release knows/);
    expect(() => assertPinned(EVM[11155111]!.all, retired, 'an HTLC factory', true)).not.toThrow();
    expect(() => assertPinned(TRON.mainnet.fund, 'TAyJCZ9a5uszYZw2Rt4RMLpJCQqQGhSz1p', 'a pool')).toThrow();
    expect(() => assertPinned(TRON.mainnet.all, 'TAyJCZ9a5uszYZw2Rt4RMLpJCQqQGhSz1p', 'a pool')).not.toThrow();
    // A Nile pool is not a mainnet pool.
    expect(() => assertPinned(TRON.mainnet.all, 'TQRHZmUjnNeSadw2d3R7W1gqinwQyQ77Kk', 'a pool')).toThrow();
    expect(BITCOIN.mainnet.confirmations).toBe(3);
  });

  it('reads decimals from the pin, not the registry', () => {
    expect(pinnedAsset('evm', '0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT')?.decimals).toBe(6);
    expect(pinnedAsset('tron', null, 'TRX')?.decimals).toBe(6);
    expect(pinnedAsset('evm', '0x0000000000000000000000000000000000000001', 'X')).toBeNull();
  });

  it("takes the network from the agent's own endpoints, never from /config", async () => {
    const api = (chainId: number, rpcUrl: string) =>
      ({ evmChain: async () => ({ rpcUrl, chainId, factory: '0xa9B6a64837259034E949787B5d17Bfa46304ff71' }) }) as unknown as HashlockClient;
    net({ evmChainId: 8453 });
    await expect(evmNet(api(8453, 'https://rpc-a'), 'base')).resolves.toMatchObject({ chainId: 8453 });
    // The API says Ethereum mainnet; the agent's RPC is on Base: refused.
    await expect(evmNet(api(1, 'https://rpc-b'), 'ethereum')).rejects.toThrow(/answers for chain 8453/);
    net({ evmChainId: 999 });
    await expect(evmNet(api(999, 'https://rpc-c'), 'x')).rejects.toThrow(/not one this release settles on/);

    const tronApi = (fullHost: string) => ({ tronChain: async () => ({ fullHost }) }) as unknown as HashlockClient;
    net({ tronGenesis: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc' });
    await expect(tronNet(tronApi('https://nile'))).resolves.toMatchObject({ net: 'testnet' });
    net({ tronGenesis: 'ff' });
    await expect(tronNet(tronApi('https://other'))).rejects.toThrow(/not a network this release settles on/);

    net({ solanaGenesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
    await expect(solanaNet({ solanaRpc: 'https://sol-a' } as unknown as HashlockClient)).resolves.toMatchObject({ net: 'mainnet' });
  });
});

// ── the deal as agreed ───────────────────────────────────────────────────────
const USDT_ETH: AssetSnapshot = { id: 'usdt', symbol: 'USDT', chain: 'ethereum', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', isNative: false };
const BTC: AssetSnapshot = { id: 'btc', symbol: 'BTC', chain: 'bitcoin', address: null, isNative: true };
/** Taker (the agent) sells 600 sats of BTC for 1000 USDT: the maker gives USDT (leg a), the taker gives BTC (leg b). */
const agreement: Agreement = { side: 'taker', direction: 'sell_base', base: BTC, quote: USDT_ETH, baseAmount: '600', prices: { th: ['1000'] } };
const dealSwap = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: SWAP_ID,
    rfqId: 'rfq',
    threadId: 'th',
    makerId: 'maker',
    takerId: 'me',
    initiatorUserId: 'me',
    status: 'agreed',
    hashlock: `0x${H}`,
    secretCiphertext: null,
    feeAssetId: 'btc',
    feeAmount: '0',
    aAssetId: 'usdt',
    aChain: 'ethereum',
    aAmount: '1000',
    aTimelock: new Date((Math.floor(Date.now() / 1000) + 4 * 3600) * 1000).toISOString(),
    bAssetId: 'btc',
    bChain: 'bitcoin',
    bAmount: '600',
    bTimelock: new Date((Math.floor(Date.now() / 1000) + 24 * 3600) * 1000).toISOString(),
    ...over,
  }) as unknown as Swap;
const meApi = { me: async () => ({ user: { id: 'me' } }) };
const store = (a: Agreement | null = agreement, addresses: string[] = []) => ({ get: () => a, rely: vi.fn(), addressesFor: () => addresses, takeOnce: vi.fn() });

describe('checkDeal: the swap is what the agent agreed to', () => {
  const check = (swap: Swap, a: Agreement | null = agreement) => checkDeal(meApi as unknown as HashlockClient, swap, store(a));

  it('maps the agreement onto the legs', async () => {
    await expect(check(dealSwap())).resolves.toMatchObject({ side: 'taker', mine: 'b', theirs: 'a', asset: { a: USDT_ETH, b: BTC } });
  });
  it('refuses a deal with no local record', async () => {
    await expect(check(dealSwap(), null)).rejects.toThrow(/no record of agreeing/);
  });
  it('refuses the other side, other assets, other amounts and a price never agreed', async () => {
    await expect(check(dealSwap({ takerId: 'someone' }))).rejects.toThrow(/agreed as the taker/);
    await expect(check(dealSwap({ aAssetId: 'usdc' }))).rejects.toThrow(/leg a is usdc/);
    await expect(check(dealSwap({ bChain: 'tron' }))).rejects.toThrow(/leg b is btc@tron/);
    await expect(check(dealSwap({ bAmount: '601' }))).rejects.toThrow(/base leg is 601/);
    await expect(check(dealSwap({ aAmount: '999' }))).rejects.toThrow(/not a price this agent agreed to in this thread/);
    // A price agreed in ANOTHER thread is not this deal's; a private order's ask counts in any thread.
    await expect(check(dealSwap({ threadId: 'other' }))).rejects.toThrow(/not a price this agent agreed to in this thread/);
    // Re-agreeing at another price later does not disown the earlier, live swap.
    await expect(check(dealSwap(), { ...agreement, prices: { th: ['1000', '1200'] } })).resolves.toMatchObject({ mine: 'b' });
    await expect(check(dealSwap({ threadId: 'other' }), { ...agreement, ask: '1000' })).resolves.toMatchObject({ mine: 'b' });
  });
  it('refuses an overcharged fee, a fee on the wrong leg and a timelock beyond the ceiling', async () => {
    await expect(check(dealSwap({ feeAmount: '2' }))).rejects.toThrow(/protocol fee/); // 2/600 > 30 bps
    await expect(check(dealSwap({ feeAmount: '1', feeAssetId: 'usdt' }))).rejects.toThrow(/protocol fee/);
    await expect(check(dealSwap({ aTimelock: new Date(Date.now() + 30 * 3600_000).toISOString() }))).rejects.toThrow(/beyond 27h/);
    await expect(check(dealSwap({ aTimelock: 'garbage' }))).rejects.toThrow(/missing/);
  });
});

describe('AgreementStore', () => {
  it('keeps every price agreed per thread, refuses changed terms and a request it neither created nor quoted', () => {
    const { agreements } = tmpStore();
    const terms = { side: 'maker' as const, direction: 'buy_base' as const, base: BTC, quote: USDT_ETH, baseAmount: '600' };
    agreements.agree('r', 't1', '1000', terms);
    agreements.agree('r', 't1', '1100');
    agreements.agree('r', 't2', '900');
    agreements.agree('r', 't1', '1100');
    expect(agreements.get('r')?.prices).toEqual({ t1: ['1000', '1100'], t2: ['900'] });
    expect(() => agreements.agree('r', 't1', '1', { ...terms, baseAmount: '601' })).toThrow(/no longer has the terms/);
    expect(() => agreements.agree('r', 't1', '1', { ...terms, side: 'taker' })).toThrow(/no longer has the terms/);
    expect(() => agreements.agree('elsewhere', 't', '1')).toThrow(/not created or quoted through this MCP/);
    agreements.create('mine', { direction: 'sell_base', base: BTC, quote: USDT_ETH, baseAmount: '600', ask: '1000' });
    expect(agreements.get('mine')).toMatchObject({ side: 'taker', ask: '1000', prices: {} });
  });

  it('lets one escrow or hashlock back one swap only', () => {
    const { agreements } = tmpStore();
    agreements.rely('esc', 's1');
    agreements.rely('esc', 's1');
    expect(() => agreements.rely('esc', 's2')).toThrow(/already backs swap s1/);
  });
});

// ── Bitcoin: the escrow is rebuilt here ──────────────────────────────────────
// Produced by the API's buildHTLCScript (packages/api/src/chains/bitcoin/htlc-script.ts) for keys 0x01…01
// (receiver) and 0x02…02 (sender), hashlock 0xab…ab, timelock 1893456000.
const RECEIVER = '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f';
const SENDER = Buffer.from('024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766', 'hex');
const API_SCRIPT =
  '6382012088a820abababababababababababababababababababababababababababababababab8821031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078fac670480d8db70b17521024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ac68';
const p2wsh = (script: Buffer) =>
  bitcoin.payments.p2wsh({ redeem: { output: script, network: bitcoin.networks.testnet }, network: bitcoin.networks.testnet }).address!;

describe('Bitcoin: the escrow is rebuilt here', () => {
  it('builds the same script as the API', () => {
    expect(htlcScript(H, RECEIVER, SENDER, TL).toString('hex')).toBe(API_SCRIPT);
  });

  const read = (over: Partial<Parameters<typeof readBtcEscrow>[2]> = {}) =>
    readBtcEscrow('https://esplora', 'signet', {
      htlcAddress: p2wsh(Buffer.from(API_SCRIPT, 'hex')),
      redeemScript: API_SCRIPT,
      hashlockHex: H,
      receivers: [RECEIVER],
      timelockUnix: TL,
      confirmations: 3,
      ...over,
    });

  it('counts coin only once it is as deep as the network requires, and reads a spent escrow as closed', async () => {
    net({ esplora: { confirmed: 700, depth: 3 } });
    expect(await read()).toMatchObject({ amount: 700n, open: true });
    net({ esplora: { confirmed: 700, depth: 2 } });
    await expect(read()).rejects.toThrow(/fewer than 3 confirmation/);
    net({ esplora: { confirmed: 0, mempool: 700 } });
    await expect(read()).rejects.toThrow(/fewer than 3 confirmation/);
    net({ esplora: { confirmed: 0, spent: 700 } });
    expect((await read()).open).toBe(false);
  });

  it('refuses a script that pays another key, or another timelock, or a different address', async () => {
    net({ esplora: { confirmed: 700 } });
    const other = '02' + '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766';
    await expect(read({ receivers: [other] })).rejects.toThrow(/not the HTLC these terms produce/);
    await expect(read({ timelockUnix: TL - 1 })).rejects.toThrow(/not the HTLC these terms produce/);
    await expect(read({ htlcAddress: p2wsh(Buffer.from('51', 'hex')) })).rejects.toThrow(/hashes to/);
  });
});

// ── Solana: escrow accounts and server-built transactions ────────────────────
const SOL_SECRET = '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM';
const PUB = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const ESCROW = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf';
const OTHER_ESCROW = base58Encode(Buffer.alloc(32, 5));
const HTLC = '7Egsecq7YU5n7PonndM7W7W92EFLZVGrnoaNPW8n1DEc';
const BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const OTHER = base58Encode(Buffer.alloc(32, 4));
const RECIPIENT = base58Encode(Buffer.alloc(32, 9));
/** Account keys every built transaction carries; instructions name them by index. */
const KEYS = [PUB, ESCROW, MINT, OTHER_MINT, OTHER, BUDGET, HTLC, SYSTEM, OTHER_ESCROW];
const at = (k: string) => KEYS.indexOf(k);
const u16 = (n: number) => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
const price = (microLamports: bigint) => {
  const d = Buffer.alloc(9);
  d[0] = 3; // SetComputeUnitPrice
  d.writeBigUInt64LE(microLamports, 1);
  return d;
};
/** A legacy transaction, fee payer PUB, from [program, account keys, data] triples — shaped like the server's (tx.ts). */
function tx(ixs: Array<[string, string[], Buffer]>): string {
  const keys = KEYS.map((k) => base58Decode(k));
  const body = ixs.map(([p, accts, d]) => Buffer.concat([Buffer.from([at(p), accts.length, ...accts.map(at), ...u16(d.length)]), d]));
  const message = Buffer.concat([Buffer.from([1, 0, 3, keys.length]), ...keys, Buffer.alloc(32), Buffer.from([body.length]), ...body]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}
const disc = (hex: string) => Buffer.from(hex, 'hex');
const sign = (built: string, pin: SolanaPin) => new SolanaSigner(SOL_SECRET).signTransaction(built, ESCROW, pin);

describe('Solana: an escrow that already exists is not funded again', () => {
  it('reads whether the account exists', async () => {
    net({ solanaAccount: true });
    await expect(solanaAccountExists('https://sol', 'x')).resolves.toBe(true);
    net({ solanaAccount: false });
    await expect(solanaAccountExists('https://sol', 'x')).resolves.toBe(false);
  });
});

describe('Solana: the escrow account', () => {
  const account = (state = 0, swapId = SWAP_ID) => {
    const b = Buffer.alloc(210);
    createHash('sha256').update('account:Escrow').digest().copy(b, 0, 0, 8);
    Buffer.from(swapId.replace(/-/g, ''), 'hex').copy(b, 8);
    Buffer.from(H, 'hex').copy(b, 24);
    Buffer.alloc(32, 7).copy(b, 56); // recipient
    b.writeBigUInt64LE(1234n, 152);
    b.writeBigInt64LE(BigInt(TL), 160);
    b[176] = state;
    return b;
  };

  it('decodes the fields at the program layout offsets', () => {
    expect(decodeSolanaEscrow(account(), SWAP_ID)).toEqual({
      hashlock: H,
      recipient: base58Encode(Buffer.alloc(32, 7)),
      token: null,
      amount: 1234n,
      timelock: TL,
      open: true,
    });
    expect(decodeSolanaEscrow(account(1), SWAP_ID).open).toBe(false);
    expect(() => decodeSolanaEscrow(account(0, '00000000-0000-4000-8000-000000000000'), SWAP_ID)).toThrow(/another swap/);
    expect(() => decodeSolanaEscrow(Buffer.alloc(210), SWAP_ID)).toThrow(/not an HTLC escrow/);
  });
});

describe('Solana: every server-built transaction is decoded and bound', () => {
  const CLAIM = HTLC_INSTRUCTIONS.claim[1]; // claim_sol [payer, escrow, recipient]
  const REFUND = HTLC_INSTRUCTIONS.refund[1]; // refund_sol [payer, funder, escrow]
  const claimSol = (escrow = ESCROW, recipient = PUB) => tx([[BUDGET, [], price(50_000n)], [HTLC, [PUB, escrow, recipient], disc(CLAIM)]]);
  const claimPin: SolanaPin = { programs: [HTLC], action: 'claim', escrow: ESCROW };
  const refundPin: SolanaPin = { programs: [HTLC], action: 'refund', escrow: ESCROW };

  it('signs a capped compute price plus the one HTLC call asked for', () => {
    expect(() => sign(claimSol(), claimPin)).not.toThrow();
    expect(() => sign(tx([[HTLC, [OTHER, PUB, ESCROW], disc(REFUND)]]), refundPin)).not.toThrow();
  });

  it('lets a claim pay an address this MCP set for the leg, and nothing else besides the key', () => {
    expect(() => sign(claimSol(ESCROW, OTHER), { ...claimPin, recipients: [OTHER] })).not.toThrow();
    expect(() => sign(claimSol(ESCROW, OTHER), { ...claimPin, recipients: [RECIPIENT] })).toThrow(/does not name this agent/);
  });

  it('refuses another escrow, another recipient on a claim and another funder on a refund', () => {
    expect(() => sign(claimSol(OTHER_ESCROW), claimPin)).toThrow(/acts on another escrow/);
    expect(() => sign(claimSol(ESCROW, OTHER), claimPin)).toThrow(/does not name this agent/);
    expect(() => sign(tx([[HTLC, [PUB, OTHER, ESCROW], disc(REFUND)]]), refundPin)).toThrow(/does not name this agent/);
    expect(() => sign(tx([[HTLC, [PUB, PUB, OTHER_ESCROW], disc(REFUND)]]), refundPin)).toThrow(/another escrow/);
  });

  it('refuses a transfer beside the call, a second call, the wrong kind, and a runaway fee', () => {
    const call: [string, string[], Buffer] = [HTLC, [PUB, ESCROW, PUB], disc(CLAIM)];
    expect(() => sign(tx([call, [SYSTEM, [PUB, OTHER], Buffer.from('02000000', 'hex')]]), claimPin)).toThrow(/something other than/);
    expect(() => sign(tx([call, call]), claimPin)).toThrow(/found 2/);
    expect(() => sign(tx([call]), refundPin)).toThrow(/something other than/);
    expect(() => sign(tx([[BUDGET, [], price(1_000_001n)], call]), claimPin)).toThrow(/compute budget/);
    expect(() => sign(tx([[BUDGET, [], Buffer.from('0240420f00', 'hex')], call]), claimPin)).toThrow(/compute budget/);
  });
});

describe('Solana: a server-built fund carries the leg as the agent knows it', () => {
  const terms = { swapId: SWAP_ID, hashlock: `0x${H}`, recipient: RECIPIENT, amount: 5000n, timelock: TL, fee: 30n };
  /** `fund`/`fund_sol` data per the committed IDL: discriminator, swap_id, terms, hashlock, recipient, amount, timelock, fee. */
  const data = (t: typeof terms, token: boolean) => {
    const n = Buffer.alloc(24);
    n.writeBigUInt64LE(t.amount, 0);
    n.writeBigInt64LE(BigInt(t.timelock), 8);
    n.writeBigUInt64LE(t.fee, 16);
    return Buffer.concat([
      Buffer.from(HTLC_INSTRUCTIONS.fund[token ? 0 : 1], 'hex'),
      Buffer.from(t.swapId.replace(/-/g, ''), 'hex'),
      Buffer.alloc(32, 1), // terms: the program checks it against the args, so the args are what bind
      Buffer.from(t.hashlock.slice(2), 'hex'),
      base58Decode(t.recipient),
      n,
    ]);
  };
  /** fund_sol [funder, escrow, treasury, config, system]; fund [funder, escrow, …, mint 7th, …]. */
  const fund = (t: typeof terms, o: { token?: boolean; funder?: string; mint?: string } = {}) =>
    tx([
      [BUDGET, [], price(50_000n)],
      [
        HTLC,
        o.token ? [o.funder ?? PUB, ESCROW, OTHER, OTHER, OTHER, OTHER, o.mint ?? MINT, SYSTEM, SYSTEM, SYSTEM] : [o.funder ?? PUB, ESCROW, OTHER, OTHER, SYSTEM],
        data(t, !!o.token),
      ],
    ]);
  const pin = (mint: string | null): SolanaPin => ({ programs: [HTLC], action: 'fund', mint, fund: terms });

  it('builds the same bytes as the markets encoder (encodeChecked, build.ts)', () => {
    // encodeChecked('fund_sol', …) for these terms, terms field 0x01…01, run in packages/api.
    expect(data(terms, false).toString('hex')).toBe(
      '9c81db22a1d6e7380f8e1a2b3c4d4e5f8a9b0c1d2e3f4a5b0101010101010101010101010101010101010101010101010101010101010101abababababababababababababababababababababababababababababababab0909090909090909090909090909090909090909090909090909090909090909881300000000000080d8db70000000001e00000000000000',
    );
  });

  it('signs a native and a token fund whose terms are the agreed ones', () => {
    expect(() => sign(fund(terms), pin(null))).not.toThrow();
    expect(() => sign(fund(terms, { token: true }), pin(MINT))).not.toThrow();
  });

  it('refuses a tampered timelock, amount, hashlock, recipient, fee, swap, asset, mint or funder', () => {
    expect(() => sign(fund({ ...terms, timelock: TL + 48 * 3600 }), pin(null))).toThrow(/timelock/);
    expect(() => sign(fund({ ...terms, amount: 5001n }), pin(null))).toThrow(/locks 5001/);
    expect(() => sign(fund({ ...terms, hashlock: `0x${'cd'.repeat(32)}` }), pin(null))).toThrow(/another hashlock/);
    expect(() => sign(fund({ ...terms, recipient: PUB }), pin(null))).toThrow(/pays/);
    expect(() => sign(fund({ ...terms, fee: 0n }), pin(null))).toThrow(/fee/);
    expect(() => sign(fund({ ...terms, swapId: '00000000-0000-4000-8000-000000000000' }), pin(null))).toThrow(/another swap/);
    expect(() => sign(fund(terms, { token: true }), pin(null))).toThrow(/is for a token/);
    expect(() => sign(fund(terms), pin(MINT))).toThrow(/native SOL/);
    expect(() => sign(fund(terms, { token: true, mint: OTHER_MINT }), pin(MINT))).toThrow(/another mint/);
    expect(() => sign(fund(terms, { funder: OTHER }), pin(null))).toThrow(/does not name this agent/);
  });
});

// ── the flows: fund, claim, release ──────────────────────────────────────────
const ECPair = ECPairFactory(ecc);
const btcSigner = new BtcSigner(ECPair.fromPrivateKey(Buffer.alloc(32, 1), { network: bitcoin.networks.testnet }).toWIF(), 'signet');
const now = () => Math.floor(Date.now() / 1000);

describe('fundMyLeg as the counterparty: the initiator escrow is checked on chain', () => {
  // The agent is the MAKER giving 1000 USDT (leg a) for the taker's 600 sats (leg b); the taker initiated on Bitcoin.
  const makerAgreement: Agreement = { ...agreement, side: 'maker' };
  const bTl = now() + 24 * 3600;
  const script = htlcScript(H, btcSigner.pubkeyHex, SENDER, bTl);
  const swap = (over: Partial<Record<string, unknown>> = {}) =>
    dealSwap({
      makerId: 'me',
      takerId: 'taker',
      initiatorUserId: 'taker',
      status: 'initiator_funded',
      aTimelock: new Date((bTl - MIN_TIMELOCK_GAP_SECONDS) * 1000).toISOString(),
      aPayoutAddress: '0x' + '11'.repeat(20),
      aFundTx: null,
      bTimelock: new Date(bTl * 1000).toISOString(),
      bHtlcAddress: p2wsh(script),
      bRedeemScript: script.toString('hex'),
      bFundTx: 'f',
      ...over,
    });
  const evmFund = vi.fn(async () => '0xtx');
  const api = (factory = '0xa9B6a64837259034E949787B5d17Bfa46304ff71') =>
    ({
      ...meApi,
      familyOf: async (c: string) => (c === 'bitcoin' ? 'btc' : 'evm'),
      btcSigner: async () => btcSigner,
      btcEsplora: () => 'https://esplora',
      evmSigner: () => ({ address: '0x' + '22'.repeat(20), fund: evmFund }),
      evmChain: async () => ({ rpcUrl: 'https://eth', chainId: 1, factory }),
    }) as unknown as HashlockClient;
  const none = { findByHashlock: () => null, markFunded: vi.fn() };

  it('refuses while the initiator escrow holds less than agreed, or is not deep enough', async () => {
    net({ evmChainId: 1, esplora: { confirmed: 599 } });
    await expect(fundMyLeg(api(), swap(), none, store(makerAgreement))).rejects.toThrow(/holds 599, less than the agreed 600/);
    net({ evmChainId: 1, esplora: { confirmed: 600, depth: 0 } });
    await expect(fundMyLeg(api(), swap(), none, store(makerAgreement))).rejects.toThrow(/confirmation/);
    expect(evmFund).not.toHaveBeenCalled();
  });

  it('refuses an initiator timelock less than the gap beyond its own', async () => {
    net({ evmChainId: 1, esplora: { confirmed: 600 } });
    const short = swap({ aTimelock: new Date((bTl - MIN_TIMELOCK_GAP_SECONDS + 1) * 1000).toISOString() });
    await expect(fundMyLeg(api(), short, none, store(makerAgreement))).rejects.toThrow(/expires at/);
  });

  it('funds through the pinned factory, in the pinned token, and records the escrow it relied on', async () => {
    net({ evmChainId: 1, esplora: { confirmed: 600 } });
    await expect(fundMyLeg(api('0x' + '33'.repeat(20)), swap(), none, store(makerAgreement))).rejects.toThrow(/not an HTLC factory/);
    const s = store(makerAgreement);
    await expect(fundMyLeg(api(), swap(), none, s)).resolves.toMatchObject({ tx: '0xtx', leg: 'a' });
    expect(evmFund).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1 }),
      expect.objectContaining({ token: '0xdac17f958d2ee523a2206206994597c13d831ec7', amount: 1000n }),
    );
    expect(s.rely).toHaveBeenCalledWith(`bitcoin:${p2wsh(script)}`, SWAP_ID);
  });

  it('refuses to fund an escrow that already exists on chain (a retry must not pay twice)', async () => {
    net({ evmChainId: 1, evmCode: '0x6080', esplora: { confirmed: 600 } });
    await expect(fundMyLeg(api(), swap(), none, store(makerAgreement))).rejects.toThrow(/already exists — not funding it again/);
  });

  it('refuses a swap row rewritten after the agreement', async () => {
    net({ evmChainId: 1, esplora: { confirmed: 600 } });
    await expect(fundMyLeg(api(), swap({ aAmount: '1001' }), none, store(makerAgreement))).rejects.toThrow(/not a price this agent agreed to/);
  });
});

describe('fundMyLeg as the initiator', () => {
  const bTl = now() + 24 * 3600;
  const ours = p2wsh(htlcScript(H, RECEIVER, Buffer.from(btcSigner.pubkeyHex, 'hex'), bTl));
  const sw = (over: Partial<Record<string, unknown>> = {}) =>
    dealSwap({ bTimelock: new Date(bTl * 1000).toISOString(), bPayoutAddress: RECEIVER, bHtlcAddress: ours, bFundTx: null, ...over });
  const btcFund = vi.fn(async () => 'btctx');
  const signer = Object.assign(Object.create(Object.getPrototypeOf(btcSigner)), btcSigner, { fund: btcFund });
  const api = { ...meApi, familyOf: async () => 'btc', btcSigner: async () => signer, btcEsplora: () => 'https://esplora' } as unknown as HashlockClient;
  const entry = { secret: '', hashlock: H, createdAt: '', rfqId: 'rfq' };
  const mine = { findByHashlock: () => ({ threadId: 'th', entry }), markFunded: vi.fn() };
  const withEntry = (over: Record<string, unknown>) => ({ ...mine, findByHashlock: () => ({ threadId: 'th', entry: { ...entry, ...over } }) });

  it('funds the script it derives itself, paying the fee only to the pinned treasury', async () => {
    net({ esplora: { confirmed: 0 } });
    const s = store();
    await expect(fundMyLeg(api, sw(), mine, s)).resolves.toMatchObject({ tx: 'btctx', leg: 'b' });
    expect(s.rely).toHaveBeenCalledWith(`hashlock:${H}`, SWAP_ID);
    expect(btcFund).toHaveBeenCalledWith(
      { network: 'signet', esplora: 'https://esplora', treasury: BITCOIN.testnet.treasury },
      expect.objectContaining({ p2wsh: ours, amountSats: 600n }),
    );
  });

  it("refuses an API escrow address that is not that script — someone else's refund branch", async () => {
    const theirs = p2wsh(htlcScript(H, RECEIVER, SENDER, bTl));
    await expect(fundMyLeg(api, sw({ bHtlcAddress: theirs }), mine, store())).rejects.toThrow(/not the HTLC the agreed terms produce/);
  });

  it('locks only under its own unrevealed secret for this request, and only when the API agrees it is the initiator', async () => {
    await expect(fundMyLeg(api, sw(), { findByHashlock: () => null, markFunded: vi.fn() }, store())).rejects.toThrow(/not sha256 of a secret this process holds/);
    await expect(fundMyLeg(api, sw(), withEntry({ revealedAt: 'x' }), store())).rejects.toThrow(/already revealed/);
    await expect(fundMyLeg(api, sw(), withEntry({ rfqId: 'other' }), store())).rejects.toThrow(/made for request other/);
    await expect(fundMyLeg(api, sw({ initiatorUserId: 'maker' }), mine, store())).rejects.toThrow(/names the other side as the initiator/);
    await expect(fundMyLeg(api, sw(), withEntry({ fundedFor: 'an-earlier-swap' }), store())).rejects.toThrow(/already locks your leg of swap an-earlier-swap/);
  });

  it('refuses a leg about to expire, a hashlock already funded for another swap, and an escrow already paid', async () => {
    await expect(fundMyLeg(api, sw({ bTimelock: new Date((now() + 600) * 1000).toISOString() }), mine, store())).rejects.toThrow(/minutes away/);
    const { agreements } = tmpStore();
    const real = { get: () => agreement, rely: (k: string, id: string) => agreements.rely(k, id), addressesFor: () => [], takeOnce: (k: string, w: string) => agreements.takeOnce(k, w) };
    agreements.rely(`hashlock:${H}`, 'an-earlier-swap');
    net({ esplora: { confirmed: 0 } });
    await expect(fundMyLeg(api, sw(), mine, real)).rejects.toThrow(/already backs swap an-earlier-swap/);
    net({ esplora: { confirmed: 0, mempool: 600 } });
    await expect(fundMyLeg(api, sw(), mine, store())).rejects.toThrow(/already been paid/);
    // Dust somebody else sent there does not block the agent's funding.
    net({ esplora: { confirmed: 546 } });
    await expect(fundMyLeg(api, sw(), mine, store())).resolves.toMatchObject({ tx: 'btctx' });
    // A swap's own leg is funded once — a retry, or a second call racing the first, is refused whatever
    // terms the API reports this time.
    const once = tmpStore().agreements;
    const st = { ...store(), takeOnce: (k: string, w: string) => once.takeOnce(k, w) };
    net({ esplora: { confirmed: 0 } });
    const [a, b] = await Promise.allSettled([fundMyLeg(api, sw(), mine, st), fundMyLeg(api, sw(), mine, st)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    await expect(fundMyLeg(api, sw(), mine, st)).rejects.toThrow(/already sent once/);
    expect(mine.markFunded).toHaveBeenCalledWith('th', H, SWAP_ID);
  });
});

describe('the secret leaves only through releaseOwnSecret', () => {
  const S = '33'.repeat(32);
  const SH = createHash('sha256').update(Buffer.from(S, 'hex')).digest('hex');

  it("claims with the initiator's revealed secret when the hashlock is not ours — after checking it opens it", async () => {
    const claim = vi.fn(async () => '0xclaim');
    const api = {
      ...meApi,
      familyOf: async () => 'evm',
      evmSigner: () => ({ claim }),
      evmChain: async () => ({ rpcUrl: 'https://eth2', chainId: 1 }),
      reveal: async () => ({}),
    } as unknown as HashlockClient;
    const swap = dealSwap({ makerId: 'me', takerId: 't', initiatorUserId: 't', hashlock: SH, secretCiphertext: S, bChain: 'ethereum', bClaimTx: null, bHtlcAddress: '0x' + '44'.repeat(20) });
    const secrets = { findByHashlock: () => null, markRevealed: vi.fn() };
    net({ evmChainId: 1 });
    await claimMyLeg(api, swap, secrets, store());
    expect(claim).toHaveBeenCalledWith(expect.anything(), swap.bHtlcAddress, S);
    expect(secrets.markRevealed).not.toHaveBeenCalled();
    await expect(claimMyLeg(api, { ...swap, secretCiphertext: '44'.repeat(32) } as Swap, secrets, store())).rejects.toThrow(/does not open/);
  });

  it('checks the deal and the counterparty escrow before releasing its own secret, whatever the API says about roles', async () => {
    const markRevealed = vi.fn();
    const own = { secret: S, hashlock: SH, createdAt: '', rfqId: 'rfq' };
    const secrets = { findByHashlock: () => ({ threadId: 'th', entry: own }), markRevealed };
    const api = {
      ...meApi,
      familyOf: async () => {
        throw new Error('escrow check reached');
      },
    } as unknown as HashlockClient;
    // The API calls the other side the initiator; the hashlock is still ours, so the gate runs.
    const swap = dealSwap({ hashlock: SH, initiatorUserId: 'maker', aHtlcAddress: '0x' + '55'.repeat(20) });
    await expect(releaseOwnSecret(api, swap, secrets, store())).rejects.toThrow(/escrow check reached/);
    await expect(releaseOwnSecret(api, swap, secrets, store(null))).rejects.toThrow(/no record of agreeing/);
    expect(markRevealed).not.toHaveBeenCalled();
    // A swap pairing this hashlock with another request's agreement, or another thread, is not this secret's deal.
    await expect(releaseOwnSecret(api, { ...swap, rfqId: 'small' } as Swap, secrets, store())).rejects.toThrow(/made for request rfq, not small/);
    await expect(releaseOwnSecret(api, { ...swap, threadId: 'other' } as Swap, secrets, store())).rejects.toThrow(/made for thread th, not other/);
    // Released before: checked again all the same — until the claim is on chain the escrow can change.
    const revealed = { ...secrets, findByHashlock: () => ({ threadId: 'th', entry: { ...own, revealedAt: 'x' } }) };
    await expect(releaseOwnSecret(api, swap, revealed, store())).rejects.toThrow(/escrow check reached/);
    // Not ours at all: nothing to release.
    await expect(releaseOwnSecret(api, swap, { ...secrets, findByHashlock: () => null }, store())).resolves.toBeNull();
  });
});

describe('who may be paid: the agent\'s own key, or an address it set itself', () => {
  // The agent (maker, initiator) gives USDT on leg a and receives the taker's BTC on leg b — paid to a cold
  // wallet it set with set_settlement_address, not to HASHLOCK_BTC_KEY.
  const S = '66'.repeat(32);
  const SH = createHash('sha256').update(Buffer.from(S, 'hex')).digest('hex');
  const COLD = Buffer.from(ECPair.fromPrivateKey(Buffer.alloc(32, 3)).publicKey).toString('hex'); // not HASHLOCK_BTC_KEY
  const bTl = now() + 3 * 3600;
  const swapPaying = (receiver: string) => {
    const script = htlcScript(SH, receiver, SENDER, bTl);
    return dealSwap({
      makerId: 'me', takerId: 'taker', initiatorUserId: 'me', hashlock: SH,
      bTimelock: new Date(bTl * 1000).toISOString(), bHtlcAddress: p2wsh(script), bRedeemScript: script.toString('hex'),
    });
  };
  const makerAgreement: Agreement = { ...agreement, side: 'maker' };
  const api = { ...meApi, familyOf: async () => 'btc', btcSigner: async () => btcSigner, btcEsplora: () => 'https://esplora' } as unknown as HashlockClient;
  const secrets = () => ({ findByHashlock: () => ({ threadId: 'th', entry: { secret: S, hashlock: SH, createdAt: '', rfqId: 'rfq' } }), markRevealed: vi.fn() });

  it('releases the secret against an escrow paying an address this MCP recorded for the swap', async () => {
    net({ esplora: { confirmed: 600 } });
    const s = secrets();
    await expect(releaseOwnSecret(api, swapPaying(COLD), s, store(makerAgreement, [COLD]))).resolves.toMatchObject({ secret: S });
    expect(s.markRevealed).toHaveBeenCalledWith('th', SH);
  });

  it('refuses an escrow paying an address the API calls ours but this MCP never set', async () => {
    net({ esplora: { confirmed: 600 } });
    const s = secrets();
    await expect(releaseOwnSecret(api, swapPaying(COLD), s, store(makerAgreement, []))).rejects.toThrow(/settled in the web app/);
    expect(s.markRevealed).not.toHaveBeenCalled();
  });

  it('trusts only the latest address per swap, chain and leg', () => {
    const { agreements } = tmpStore();
    agreements.recordAddress('s1', { chain: 'Bitcoin', address: 'typo', threadId: 'th', hashlock: SH });
    agreements.recordAddress('s1', { chain: 'bitcoin', address: COLD, threadId: 'th', hashlock: SH });
    expect(agreements.addressesFor('s1', 'bitcoin', 'b')).toEqual([COLD]);
    expect(agreements.addressesFor('s1', 'ethereum', 'b')).toEqual([]);
    expect(agreements.addressesFor('s2', 'bitcoin', 'b')).toEqual([]);
    // Both legs on one chain: a refund address set for the agent's own leg is not a payout for the other.
    agreements.recordAddress('s3', { chain: 'ethereum', leg: 'a', address: 'refund', threadId: 'th', hashlock: SH });
    agreements.recordAddress('s3', { chain: 'ethereum', leg: 'b', address: 'payout', threadId: 'th', hashlock: SH });
    expect(agreements.addressesFor('s3', 'ethereum', 'b')).toEqual(['payout']);
    // A record naming no leg and one naming a leg replace each other: the corrected one is gone.
    agreements.recordAddress('s4', { chain: 'tron', address: 'X', threadId: 'th', hashlock: SH });
    agreements.recordAddress('s4', { chain: 'tron', leg: 'b', address: 'Y', threadId: 'th', hashlock: SH });
    expect(agreements.addressesFor('s4', 'tron', 'b')).toEqual(['Y']);
  });
});

describe('a refused funding leaves the hashlock free', () => {
  it('records nothing when a check refuses before the signer is called', async () => {
    const bTl = now() + 24 * 3600;
    const theirs = p2wsh(htlcScript(H, RECEIVER, SENDER, bTl)); // not the agent's refund branch: refused
    const swap = dealSwap({ bTimelock: new Date(bTl * 1000).toISOString(), bPayoutAddress: RECEIVER, bHtlcAddress: theirs, bFundTx: null });
    const api = { ...meApi, familyOf: async () => 'btc', btcSigner: async () => btcSigner, btcEsplora: () => 'https://esplora' } as unknown as HashlockClient;
    const markFunded = vi.fn();
    const s = store();
    const secrets = { findByHashlock: () => ({ threadId: 'th', entry: { secret: '', hashlock: H, createdAt: '', rfqId: 'rfq' } }), markFunded };
    await expect(fundMyLeg(api, swap, secrets, s)).rejects.toThrow(/not the HTLC the agreed terms produce/);
    expect(markFunded).not.toHaveBeenCalled();
    expect(s.rely).not.toHaveBeenCalled();
  });
});

describe('SecretStore', () => {
  it('marks a secret revealed, gives a reopened thread a fresh one, and keeps the old one findable', () => {
    const { secrets } = tmpStore();
    const first = secrets.generate('th', 'r');
    expect(secrets.generate('th', 'r').secret).toBe(first.secret);
    expect(() => secrets.generate('th', 'another-request')).toThrow(/is on request r/);
    secrets.markRevealed('nope');
    secrets.markRevealed('th');
    const next = secrets.generate('th', 'r');
    expect(next.secret).not.toBe(first.secret);
    expect(secrets.findByHashlock(first.hashlock)).toMatchObject({ threadId: 'th', entry: { secret: first.secret } });
    expect(secrets.findByHashlock(next.hashlock)?.entry.revealedAt).toBeUndefined();
    // Funded under, never revealed (a refund): the reopened thread's next deal still gets a fresh secret.
    secrets.markFunded('th', next.hashlock, 's1');
    expect(() => secrets.markFunded('th', next.hashlock, 's2')).toThrow(/already locks swap s1/);
    expect(secrets.generate('th', 'r').secret).not.toBe(next.secret);
  });

  it('treats a secret from before this release as possibly handed out, and gives a fresh one', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'hl-'));
    writeFileSync(join(dir, 's.json'), JSON.stringify({ th: { secret: '77'.repeat(32), hashlock: 'x', createdAt: '' } }));
    expect(new SecretStore(join(dir, 's.json')).generate('th', 'r').secret).not.toBe('77'.repeat(32));
  });

  it('refuses to read a corrupt store rather than overwrite it as empty', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'hl-'));
    writeFileSync(join(dir, 's.json'), '{ not json');
    expect(() => new SecretStore(join(dir, 's.json')).generate('t', 'r')).toThrow(/not readable JSON/);
  });
});
