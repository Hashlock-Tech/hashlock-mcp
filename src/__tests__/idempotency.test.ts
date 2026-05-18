import { describe, it, expect, vi } from 'vitest';
import { createIdempotencyGuard, idempotencyKey } from '../lib/idempotency.js';

describe('createIdempotencyGuard', () => {
  it('runs the op once per key and replays the cached result', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    const a = await guard.remember('k1', op);
    const b = await guard.remember('k1', op);
    expect(op).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('runs the op for each distinct key', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    await guard.remember('k1', op);
    await guard.remember('k2', op);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected op (a failed write may be safely retried)', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: 2 });
    await expect(guard.remember('k1', op)).rejects.toThrow('boom');
    const second = await guard.remember('k1', op);
    expect(second).toEqual({ ok: 2 });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('without a key, always runs (no dedupe)', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    await guard.remember(undefined, op);
    await guard.remember(undefined, op);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('concurrent same-key calls run op exactly once', async () => {
    const guard = createIdempotencyGuard();
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: calls };
    });
    const [a, b] = await Promise.all([
      guard.remember('k1', op),
      guard.remember('k1', op),
    ]);
    expect(op).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('failed concurrent calls evict the cache so retries can proceed', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: 2 });
    await expect(Promise.all([
      guard.remember('k1', op),
      guard.remember('k1', op),
    ])).rejects.toThrow('boom');
    expect(op).toHaveBeenCalledTimes(1);
    const result = await guard.remember('k1', op);
    expect(result).toEqual({ ok: 2 });
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe('createIdempotencyGuard — eviction cap', () => {
  it('does not grow unbounded: the oldest entry is evicted once MAX_ENTRIES is exceeded', async () => {
    const guard = createIdempotencyGuard();
    const MAX = 1000;
    // Fill the cache to exactly MAX entries
    for (let i = 0; i < MAX; i++) {
      await guard.remember(`fill-${i}`, () => Promise.resolve(i));
    }
    // The very first key should still be a cache hit (not yet evicted)
    const firstOp = vi.fn().mockResolvedValue('first-again');
    await guard.remember('fill-0', firstOp);
    expect(firstOp).not.toHaveBeenCalled(); // still cached

    // Insert one more — this should evict fill-0 (oldest)
    await guard.remember('fill-overflow', () => Promise.resolve('overflow'));

    // Now fill-0 must have been evicted: op runs again
    const evictedOp = vi.fn().mockResolvedValue('re-run');
    await guard.remember('fill-0', evictedOp);
    expect(evictedOp).toHaveBeenCalledTimes(1);

    // A recent key (fill-999) should still be cached
    const recentOp = vi.fn().mockResolvedValue('recent-again');
    await guard.remember('fill-999', recentOp);
    expect(recentOp).not.toHaveBeenCalled();
  });
});

describe('idempotencyKey helper', () => {
  it('returns undefined when clientRequestId is undefined (no dedup)', () => {
    expect(idempotencyKey('create_htlc', undefined, { tradeId: 't1' })).toBeUndefined();
  });

  it('same scope+id+payload returns the same key (dedup)', () => {
    const payload = { tradeId: 't1', amount: '1.0' };
    const k1 = idempotencyKey('create_rfq', 'req-1', payload);
    const k2 = idempotencyKey('create_rfq', 'req-1', payload);
    expect(k1).toBe(k2);
    expect(k1).toBeDefined();
  });

  it('same id but different scope returns a different key (no cross-tool replay)', () => {
    const payload = { tradeId: 't1' };
    const k1 = idempotencyKey('create_htlc', 'req-1', payload);
    const k2 = idempotencyKey('withdraw_htlc', 'req-1', payload);
    expect(k1).not.toBe(k2);
  });

  it('same scope+id but different payload returns a different key (no wrong-payload replay)', () => {
    const k1 = idempotencyKey('create_rfq', 'req-1', { amount: '1.0' });
    const k2 = idempotencyKey('create_rfq', 'req-1', { amount: '2.0' });
    expect(k1).not.toBe(k2);
  });

  it('guard deduplicates correctly when using idempotencyKey (same scope+id+payload = op once)', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    const payload = { tradeId: 't1' };
    await guard.remember(idempotencyKey('create_htlc', 'req-1', payload), op);
    await guard.remember(idempotencyKey('create_htlc', 'req-1', payload), op);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('guard runs op twice when scope differs even with same id+payload', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    const payload = { tradeId: 't1' };
    await guard.remember(idempotencyKey('create_htlc', 'req-1', payload), op);
    await guard.remember(idempotencyKey('withdraw_htlc', 'req-1', payload), op);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('guard runs op twice when payload differs even with same scope+id', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    await guard.remember(idempotencyKey('create_rfq', 'req-1', { amount: '1.0' }), op);
    await guard.remember(idempotencyKey('create_rfq', 'req-1', { amount: '2.0' }), op);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('guard runs op every time when id is undefined (no dedup)', async () => {
    const guard = createIdempotencyGuard();
    const op = vi.fn().mockResolvedValue({ ok: 1 });
    const payload = { tradeId: 't1' };
    await guard.remember(idempotencyKey('create_htlc', undefined, payload), op);
    await guard.remember(idempotencyKey('create_htlc', undefined, payload), op);
    expect(op).toHaveBeenCalledTimes(2);
  });
});
