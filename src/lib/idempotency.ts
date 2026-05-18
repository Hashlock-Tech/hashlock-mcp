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
  const cache = new Map<string, unknown>();
  return {
    async remember<T>(key: string | undefined, op: () => Promise<T>): Promise<T> {
      if (!key) return op();
      if (cache.has(key)) return cache.get(key) as T;
      const result = await op(); // only cache on success — a thrown write is retryable
      cache.set(key, result);
      return result;
    },
  };
}
