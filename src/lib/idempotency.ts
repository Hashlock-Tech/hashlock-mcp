/**
 * In-process best-effort idempotency. Scope-limited by design:
 *  - same MCP process only (not durable across restart, not cross-instance)
 *  - solves the dominant failure mode: an agent loses context and retries
 *    the SAME write within one session.
 * Durable/cross-instance dedupe needs a backend key (out of scope; tracked
 * as a backend issue).
 */
export interface IdempotencyGuard {
  remember<T>(key: string | undefined, op: () => Promise<T>): Promise<T>;
}

export function createIdempotencyGuard(): IdempotencyGuard {
  const cache = new Map<string, Promise<unknown>>();
  return {
    async remember<T>(key: string | undefined, op: () => Promise<T>): Promise<T> {
      if (!key) return op();
      const existing = cache.get(key);
      if (existing) return existing as Promise<T>;
      const promise = op().catch((err) => {
        cache.delete(key); // failed write is retryable — drop so a retry can proceed
        return Promise.reject(err);
      });
      cache.set(key, promise);
      return promise as Promise<T>;
    },
  };
}
