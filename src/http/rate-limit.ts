import { createHash } from 'node:crypto';
import type { Context, Next } from 'hono';

/**
 * Fixed-window rate limiter for the hosted MCP.
 *
 * /v1 already limits per API key, so an authenticated caller is bounded downstream — but nothing stood
 * in front of this endpoint itself, which is public and reachable before any credential is checked.
 *
 * WHO A CALLER IS. This process never checks a key — /v1 does, when a tool runs — so the string after
 * "Bearer " is whatever the caller typed. Bucketing on it let every invented string open a bucket of its
 * own: 300 requests under 300 made-up tokens were 300 × 200. So a key earns its own bucket only once
 * /v1 has answered a call made with it (keyAnswered below); until then, and for every string that is
 * not a key, the bucket is the client's address. A proven key keeps its own bucket because one address
 * is many people: an MCP host's egress, an office NAT.
 *
 * The IP is read from the RIGHT-MOST X-Forwarded-For entry because the reverse proxy appends the real
 * address: taking the left-most value lets a caller spoof the header and rotate it to defeat the limit.
 * (Same reasoning as the API's limiter — an audit finding there.)
 *
 * In-memory, which is correct while this runs as a single container; move to a shared store if it is
 * ever scaled out.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Keys /v1 has accepted, by hash, each until a time. Never the raw secret. */
const proven = new Map<string, number>();
const PROVEN_MS = 60 * 60_000;
const hashOf = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 32);

/**
 * What /v1 answered to a call made with this key. Every /v1 route sits behind its key check, so a 2xx is
 * proof of a live key and a 401 is proof against it. Nothing else is evidence either way: /v1's own
 * limiter answers 429 before it looks at the key.
 */
export function keyAnswered(key: string, status: number): void {
  if (status === 401) proven.delete(hashOf(key));
  else if (status >= 200 && status < 300) proven.set(hashOf(key), Date.now() + PROVEN_MS);
}

function identity(c: Context, now: number): string {
  const auth = c.req.header('authorization');
  const key = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  if (key) {
    const h = hashOf(key);
    if ((proven.get(h) ?? 0) > now) return `k:${h}`;
  }
  const xff = c.req.header('x-forwarded-for');
  const ip = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return `i:${ip ?? c.req.header('x-real-ip') ?? 'unknown'}`;
}

export function rateLimit(opts: { windowMs: number; max: number }) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const now = Date.now();
    const id = identity(c, now);
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

    // Opportunistic sweep: without it an endpoint that sees many distinct IPs grows the maps forever,
    // which turns a rate limiter into a memory leak.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    if (proven.size > 10_000) {
      for (const [k, until] of proven) if (until <= now) proven.delete(k);
    }
    return next();
  };
}
