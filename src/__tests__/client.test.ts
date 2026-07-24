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
