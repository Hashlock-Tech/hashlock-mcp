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
    expect(api.solanaLinkStatus()).toMatch(/^not linked yet — last attempt failed: .*\(retrying in 30s\)$/);
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

  it('me({ link: false }) starts no second attempt behind a caller that already awaited one', async () => {
    let linkPosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/link-solana')) {
          linkPosts++;
          return new Response(JSON.stringify({ error: 'slow down' }), { status: 429 });
        }
        if (url.endsWith('/me')) return new Response(JSON.stringify({ user: { id: 'u', solanaAddress: null } }), { status: 200 });
        return new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 });
      }),
    );
    const api = new HashlockClient(cfg);
    await api.ensureSolanaLinked();
    const before = linkPosts;
    await api.me({ link: false }); // what whoami does
    expect(linkPosts).toBe(before);
    // …and the default still kicks one off for every other caller. The 429 floor blocks it here, which
    // is why this asserts the CALL rather than a second POST: the point is that whoami's read is not
    // the thing that starts one.
    expect(before).toBeGreaterThan(0);
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
