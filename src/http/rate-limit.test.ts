import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { rateLimit } from './rate-limit.js';

const appWith = (max: number) => {
  const app = new Hono();
  app.use('/x', rateLimit({ windowMs: 60_000, max }));
  app.all('/x', (c) => c.json({ ok: true }));
  return app;
};

const hit = (app: Hono, headers: Record<string, string> = {}) =>
  app.request('/x', { method: 'POST', headers });

describe('rateLimit', () => {
  it('lets requests through up to the limit, then 429s with Retry-After', async () => {
    const app = appWith(2);
    const h = { 'x-forwarded-for': '9.9.9.9' };
    expect((await hit(app, h)).status).toBe(200);
    expect((await hit(app, h)).status).toBe(200);
    const blocked = await hit(app, h);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('buckets per API key, so callers behind one NAT do not share a limit', async () => {
    const app = appWith(1);
    const ip = { 'x-forwarded-for': '8.8.8.8' };
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_aaa' })).status).toBe(200);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_bbb' })).status).toBe(200);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_aaa' })).status).toBe(429);
  });

  it('takes the RIGHT-MOST forwarded address, so a spoofed prefix cannot rotate the bucket', async () => {
    const app = appWith(1);
    // Same real client (appended last by the proxy), different attacker-supplied prefixes.
    expect((await hit(app, { 'x-forwarded-for': '1.1.1.1, 7.7.7.7' })).status).toBe(200);
    expect((await hit(app, { 'x-forwarded-for': '2.2.2.2, 7.7.7.7' })).status).toBe(429);
  });
});
