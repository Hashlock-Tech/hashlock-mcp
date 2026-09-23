import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromBaseUnits, HashlockClient, toBaseUnits, type Asset } from '../client.js';

const ASSETS: Asset[] = [
  { id: '11111111-1111-4111-8111-111111111111', symbol: 'USDT', name: 'Tether', chain: 'ethereum-sepolia', decimals: 6 },
  { id: '22222222-2222-4222-8222-222222222222', symbol: 'USDT', name: 'Tether', chain: 'tron-nile', decimals: 6 },
  { id: '33333333-3333-4333-8333-333333333333', symbol: 'BTC', name: 'Bitcoin', chain: 'bitcoin-signet', decimals: 8 },
];

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; json: unknown }) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(url, init);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('toBaseUnits', () => {
  it('converts exactly (no float)', () => {
    expect(toBaseUnits('0.5', 8)).toBe('50000000');
    expect(toBaseUnits('5000', 6)).toBe('5000000000');
    expect(toBaseUnits('0.000001', 6)).toBe('1');
  });
  it('tolerates grouping separators', () => {
    expect(toBaseUnits('5,000.25', 6)).toBe('5000250000');
  });
  it('rejects junk, zero, and excess precision', () => {
    expect(() => toBaseUnits('abc', 6)).toThrow(/invalid amount/);
    expect(() => toBaseUnits('0', 6)).toThrow(/positive/);
    expect(() => toBaseUnits('0.0000001', 6)).toThrow(/decimal places/);
  });
});

describe('fromBaseUnits', () => {
  it('round-trips and trims zeros', () => {
    expect(fromBaseUnits('50000000', 8)).toBe('0.5');
    expect(fromBaseUnits('5000000000', 6)).toBe('5000');
    expect(fromBaseUnits(null, 6)).toBeNull();
  });
});

describe('resolveAsset', () => {
  const client = () => new HashlockClient({ apiUrl: 'https://x', secretsPath: '/tmp/x.json' });

  it('resolves SYMBOL@chain and unique bare symbol', async () => {
    mockFetch(() => ({ json: { assets: ASSETS } }));
    const c = client();
    expect((await c.resolveAsset('usdt@tron-nile')).id).toBe(ASSETS[1]!.id);
    expect((await c.resolveAsset('BTC')).chain).toBe('bitcoin-signet');
  });

  it('rejects an ambiguous bare symbol with the candidates listed', async () => {
    mockFetch(() => ({ json: { assets: ASSETS } }));
    await expect(client().resolveAsset('USDT')).rejects.toThrow(/ambiguous.*USDT@ethereum-sepolia.*USDT@tron-nile/);
  });

  it('resolves by uuid', async () => {
    mockFetch(() => ({ json: { assets: ASSETS } }));
    expect((await client().resolveAsset(ASSETS[0]!.id)).symbol).toBe('USDT');
  });
});

describe('auth', () => {
  it('unauthenticated write fails with a helpful message', async () => {
    mockFetch(() => ({ json: {} }));
    const c = new HashlockClient({ apiUrl: 'https://x', secretsPath: '/tmp/x.json' });
    await expect(c.myRfqs()).rejects.toThrow(/HASHLOCK_TOKEN|HASHLOCK_EVM_KEY/);
  });

  it('performs SIWE login with an EVM key, sends Bearer afterwards', async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(url);
      if (url.endsWith('/auth/siwe/nonce')) return { json: { nonce: 'abc123' } };
      if (url.endsWith('/auth/siwe/verify')) return { json: { token: 'jwt-1', user: { id: 'u1' } } };
      const auth = (init?.headers as Record<string, string>)?.authorization;
      expect(auth).toBe('Bearer jwt-1');
      return { json: { rfqs: [] } };
    });
    const c = new HashlockClient({
      apiUrl: 'https://x',
      secretsPath: '/tmp/x.json',
      evmKey: `0x${'11'.repeat(32)}` as `0x${string}`,
    });
    await c.myRfqs();
    expect(calls.some((u) => u.endsWith('/auth/siwe/nonce'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/auth/siwe/verify'))).toBe(true);
  });

  it('logs in with a Solana key alone — an agent that can only settle Solana can also authenticate', async () => {
    const calls: string[] = [];
    let signed: { address?: string; message?: string; signature?: string } = {};
    mockFetch((url, init) => {
      calls.push(url);
      if (url.endsWith('/auth/siwe/nonce')) return { json: { nonce: 'abc123' } };
      if (url.endsWith('/auth/solana/verify')) {
        signed = JSON.parse(String(init?.body));
        return { json: { token: 'jwt-sol', user: { id: 'u1' } } };
      }
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer jwt-sol');
      return { json: { rfqs: [] } };
    });
    const c = new HashlockClient({
      apiUrl: 'https://x',
      secretsPath: '/tmp/x.json',
      // The all-sevens seed, as in solana.test.ts.
      solanaKey: '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM',
    });
    await c.myRfqs();
    expect(calls.some((u) => u.endsWith('/auth/solana/verify'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/auth/siwe/verify'))).toBe(false);
    // The server's binding check rejects a signature over anything that omits these.
    expect(signed.message).toContain('Hashlock Markets');
    expect(signed.message).toContain(`Address: ${signed.address}`);
    expect(signed.message).toContain('Nonce: abc123');
    expect(signed.address).toBe('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
  });

  it('re-logs-in once on 401 when a key is configured', async () => {
    let issued = 0;
    mockFetch((url, init) => {
      if (url.endsWith('/auth/siwe/nonce')) return { json: { nonce: `n${issued}` } };
      if (url.endsWith('/auth/siwe/verify')) return { json: { token: `jwt-${++issued}`, user: { id: 'u1' } } };
      const auth = (init?.headers as Record<string, string>)?.authorization;
      if (auth === 'Bearer stale') return { status: 401, json: { error: 'unauthorized' } };
      return { json: { rfqs: [] } };
    });
    const c = new HashlockClient({
      apiUrl: 'https://x',
      secretsPath: '/tmp/x.json',
      token: 'stale',
      evmKey: `0x${'11'.repeat(32)}` as `0x${string}`,
    });
    const res = await c.myRfqs();
    expect(res.rfqs).toEqual([]);
    expect(issued).toBe(1);
  });
});

/**
 * The retry-vs-settled split, which is where a High got in: a `fetch failed` TypeError is not an
 * ApiError, so classing "not an ApiError" as settled cached a one-second blip as permanent and every
 * later call threw without issuing a request.
 */
describe('the Solana link is best-effort', () => {
  const SECRET = '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM';
  const cfg = { solanaKey: SECRET, token: 'jwt' } as never;

  it('retries after a transport failure instead of caching it for the process', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/me')) {
          calls++;
          if (calls === 1) throw new TypeError('fetch failed');
          return new Response(JSON.stringify({ user: { id: 'u', solanaAddress: null } }), { status: 200 });
        }
        if (url.includes('/nonce')) return new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 });
        return new Response(JSON.stringify({ address: 'x', family: 'svm' }), { status: 200 });
      }),
    );
    const api = new HashlockClient(cfg);
    await api.ensureSolanaLinked(); // blows up inside, must not throw
    // …and SAYS SO. It used to answer a bare "not linked yet", which reads as "nothing happened" — the
    // commonest failure explaining nothing was the whole of the first half of task #75.
    expect(api.solanaLinkStatus()).toBe('not linked yet — last attempt failed: fetch failed (the next call will retry)');
    await api.ensureSolanaLinked(); // the retry the first failure must not have foreclosed
    expect(api.solanaLinkStatus()).toBe('linked');
  });

  it('names the wait when a 429 is holding the retry off, not just "not linked yet"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/me')) return new Response(JSON.stringify({ error: 'slow down' }), { status: 429 });
        return new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 });
      }),
    );
    const api = new HashlockClient(cfg);
    await api.ensureSolanaLinked();
    // The floor is 30s and it was just set, so the number is 30 — a retry the agent is waiting for, said
    // as a time rather than as silence.
    // `\d+` rather than 30: Math.ceil drops to 29 the moment a second passes between the 429 being
    // recorded and this read, which a cold start on a shared box can spend on key derivation alone.
    expect(api.solanaLinkStatus()).toMatch(/^not linked yet — last attempt failed: .*\(retrying in \d+s\)$/);
  });

  it('a settled answer replaces the transient one, and outranks it in a failed request', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/me')) {
          attempts++;
          if (attempts === 1) throw new TypeError('fetch failed');
          return new Response(JSON.stringify({ user: { id: 'u', solanaAddress: null } }), { status: 200 });
        }
        if (url.includes('/nonce')) return new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 });
        if (url.includes('/link-solana')) {
          return new Response(JSON.stringify({ error: 'that wallet belongs to another account' }), { status: 409 });
        }
        if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'prove ownership of your Solana wallet' }), { status: 400 });
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    const api = new HashlockClient(cfg);
    await api.ensureSolanaLinked(); // transient
    await api.ensureSolanaLinked(); // settled: 409
    expect(api.solanaLinkStatus()).toBe('that wallet belongs to another account');
    // And the request that fails FOR that reason carries it, rather than the stale transport blip.
    await expect(api.createRfq({} as never)).rejects.toThrow(/another account/);
  });

  it('appends the TRANSIENT reason to a request that failed for the missing link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/me')) throw new TypeError('fetch failed');
        if (url.includes('/nonce')) return new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 });
        if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'prove ownership of your Solana wallet' }), { status: 400 });
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    const api = new HashlockClient(cfg);
    // Nothing settled ever happens here, which is exactly the case that used to explain nothing: the
    // agent was told to prove ownership by the very client that had just failed trying.
    await expect(api.createRfq({} as never)).rejects.toThrow(/prove ownership.*fetch failed/s);
  });

  it('me({ link: false }) starts no attempt, and the default still does', async () => {
    mockFetch((url) =>
      url.endsWith('/me')
        ? { json: { user: { id: 'u', solanaAddress: null } } }
        : { json: { nonce: 'abc' } },
    );
    const api = new HashlockClient(cfg);
    // SPIED, not counted through the network. An earlier version of this test set a 429 first and then
    // counted POSTs — which the 429 floor suppresses on its own, so it passed with the flag ignored
    // entirely. What is being asserted is that me() does not START the attempt, and that is the call.
    const spy = vi.spyOn(api, 'ensureSolanaLinked').mockResolvedValue(undefined);
    await api.me({ link: false }); // what whoami does, having already awaited one itself
    expect(spy).not.toHaveBeenCalled();
    await api.me(); // every other caller still gets the background link
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports a conflicting account link from the ACCOUNT, with no attempt made at all', () => {
    // The steady states are the ones nobody attempts: already linked, or linked to someone else. Reading
    // the status off this process's attempt reported both as "not linked yet".
    const api = new HashlockClient(cfg);
    const mine = api.solanaLinkStatus({ solanaAddress: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB' } as never);
    expect(mine).toBe('linked');
    expect(api.solanaLinkStatus({ solanaAddress: 'SomeoneElse' } as never)).toMatch(/SomeoneElse/);
  });

  it('never throws, and reports a wallet already linked to the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/me')
          ? new Response(JSON.stringify({ user: { id: 'u', solanaAddress: 'SomeoneElsesWallet' } }), { status: 200 })
          : new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 }),
      ),
    );
    const api = new HashlockClient(cfg);
    await expect(api.ensureSolanaLinked()).resolves.toBeUndefined();
    expect(api.solanaLinkStatus()).toMatch(/SomeoneElsesWallet/);
  });

  it('does not block an agent whose Solana key is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u' } }), { status: 200 })));
    const api = new HashlockClient({ solanaKey: '1111', token: 'jwt' } as never);
    await expect(api.ensureSolanaLinked()).resolves.toBeUndefined();
    expect(api.solanaLinkStatus()).toMatch(/32 or 64 bytes/);
  });
});

/**
 * The family a chain belongs to, and where the answer comes from. The guess reads 'solana' out of a
 * name and calls everything else EVM, so a second SVM chain would be settled with an EVM signer —
 * these pin that the server's own registry wins whenever it is there.
 */
describe('familyOf on the client', () => {
  const client = () => new HashlockClient({ apiUrl: 'https://x', secretsPath: '/tmp/x.json' });
  const cfg = (chains: unknown) => ({
    chains,
    fee: { bps: 0, payer: 'taker' },
    evm: { chainId: 1, factory: null },
    tron: { sharedHtlc: null },
    btc: { network: 'signet', esplora: null, treasury: null },
  });

  it("translates the registry's own vocabulary", async () => {
    mockFetch(() => ({
      // EVERY NAME HERE WOULD BE READ WRONG by the guess — it calls anything without 'bitcoin', 'tron'
      // or 'solana' in it an EVM chain. So each row fails if the registry stops being consulted.
      json: cfg({
        eclipse: { family: 'svm' },
        'kaia-testnet': { family: 'tvm' },
        liquid: { family: 'bitcoin' },
        'plasma-testnet': { family: 'evm' },
      }),
    }));
    const c = client();
    expect(await c.familyOf('eclipse')).toBe('svm');
    expect(await c.familyOf('kaia-testnet')).toBe('tron');
    expect(await c.familyOf('liquid')).toBe('btc');
    expect(await c.familyOf('plasma-testnet')).toBe('evm');
  });

  it('refuses a family this version does not know, rather than settling it as EVM', async () => {
    mockFetch(() => ({ json: cfg({ 'some-move-chain': { family: 'move' } }) }));
    await expect(client().familyOf('some-move-chain')).rejects.toThrow(/cannot settle|upgrade/);
  });

  it('falls back to the name when the server does not say', async () => {
    mockFetch(() => ({ json: cfg(undefined) }));
    const c = client();
    expect(await c.familyOf('solana-devnet')).toBe('svm');
    expect(await c.familyOf('bitcoin-signet')).toBe('btc');
    // A chain the registry carries without a family is the same case as no registry at all.
    mockFetch(() => ({ json: cfg({ 'some-l2': {} }) }));
    expect(await client().familyOf('some-l2')).toBe('evm');
  });

  it('falls back when /config cannot be read at all, rather than throwing mid-settlement', async () => {
    mockFetch(() => ({ status: 500, json: { error: 'down' } }));
    expect(await client().familyOf('solana')).toBe('svm');
  });
});

// API task #57: each EVM leg settles on its own chain. The `evm` block is ethereum's; another chain read
// from it would sign for the wrong network.
describe('evmChain', () => {
  const cfg = { chains: {}, fee: { bps: 0, payer: 'taker' }, btc: { network: 'signet', esplora: null, treasury: null }, tron: { sharedHtlc: null } };
  const make = async (env: Record<string, string>, body: unknown) => {
    const { loadConfig } = await import('../config.js');
    mockFetch(() => ({ json: body }));
    return new HashlockClient(loadConfig({ HASHLOCK_API_URL: 'https://x', ...env }));
  };

  it('takes the chain id and factory of the leg\'s own chain, and that chain\'s RPC', async () => {
    const c = await make(
      { HASHLOCK_EVM_RPC_BASE: 'https://base.rpc/' },
      { ...cfg, evm: { chainId: 11155111, factory: '0xeth' }, endpoints: { ethereum: { chainId: 11155111, contract: '0xeth' }, base: { chainId: 84532, contract: '0xbase' } } },
    );
    expect(await c.evmChain('base')).toEqual({ rpcUrl: 'https://base.rpc', chainId: 84532, factory: '0xbase' });
    expect((await c.evmChain('ethereum')).chainId).toBe(11155111);
  });

  it('refuses a chain it has no RPC or no endpoint for, and falls back to `evm` for ethereum on an older server', async () => {
    const c = await make({}, { ...cfg, evm: { chainId: 11155111, factory: '0xeth' }, endpoints: { base: { chainId: 84532, contract: '0xbase' } } });
    await expect(c.evmChain('base')).rejects.toThrow(/HASHLOCK_EVM_RPC_BASE/);
    await expect(c.evmChain('arbitrum')).rejects.toThrow(/not configured/);
    const old = await make({}, { ...cfg, evm: { chainId: 11155111, factory: '0xeth' } });
    expect((await old.evmChain('ethereum')).factory).toBe('0xeth');
  });
});
