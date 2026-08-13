import { createHash } from 'node:crypto';
import type { Context, Next } from 'hono';

/**
 * Fixed-window rate limiter for the hosted MCP.
 *
 * /v1 already limits per API key, so an authenticated caller is bounded downstream — but nothing stood
 * in front of this endpoint itself, which is public and reachable before any credential is checked.
 *
 * Bucket by API key when one is presented, so callers behind one NAT do not share a bucket, and fall
 * back to the client IP otherwise. The IP is read from the RIGHT-MOST X-Forwarded-For entry because the
 * reverse proxy appends the real address: taking the left-most value lets a caller spoof the header and
 * rotate it to defeat the limit. (Same reasoning as the API's limiter — an audit finding there.)
 *
 * In-memory, which is correct while this runs as a single container; move to a shared store if it is
 * ever scaled out.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function identity(c: Context): string {
  const auth = c.req.header('authorization');
  const key = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  // Never bucket on the raw secret.
  if (key) return `k:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

  const xff = c.req.header('x-forwarded-for');
  const ip = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return `i:${ip ?? c.req.header('x-real-ip') ?? 'unknown'}`;
}

export function rateLimit(opts: { windowMs: number; max: number }) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const now = Date.now();
    const id = identity(c);
    const b = buckets.get(id);

    if (!b || b.resetAt <= now) {
      buckets.set(id, { count: 1, resetAt: now + opts.windowMs });
    } else if (b.count >= opts.max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      c.header('Retry-After', String(retry));
      c.header('RateLimit-Limit', String(opts.max));
      c.header('RateLimit-Remaining', '0');
      c.header('RateLimit-Reset', String(retry));
      return c.json({ error: 'rate limited — slow down' }, 429);
    } else {
      b.count += 1;
    }

    // Opportunistic sweep: without it an endpoint that sees many distinct IPs grows the map forever,
    // which turns a rate limiter into a memory leak.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return next();
  };
}
