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

const MAX_ENTRIES = 1000;

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
      // Eviction drops the oldest key by insertion order. If that entry is
      // still in-flight (pending), a re-entry for the same key will re-run
      // the op — acceptable: this guard is in-process and best-effort, and
      // 1000 simultaneous in-flight writes is not a realistic scenario here.
      if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, promise);
      return promise as Promise<T>;
    },
  };
}

/** Compose a cache key scoped by operation + exact payload so the same
 *  client_request_id reused for a different tool or a different payload
 *  does NOT replay an unrelated result. Returns undefined when no id
 *  (=> no dedup, always run). */
export function idempotencyKey(scope: string, clientRequestId: string | undefined, payload: unknown): string | undefined {
  if (!clientRequestId) return undefined;
  return `${scope}:${clientRequestId}:${JSON.stringify(payload)}`;
}
