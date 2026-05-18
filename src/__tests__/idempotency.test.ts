import { describe, it, expect, vi } from 'vitest';
import { createIdempotencyGuard } from '../lib/idempotency.js';

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
});
