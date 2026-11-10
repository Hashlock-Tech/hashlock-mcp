import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { keyAnswered, rateLimit } from './rate-limit.js';

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

  it('gives a key its own bucket once /v1 has answered a call made with it, so callers behind one NAT do not share a limit', async () => {
    const app = appWith(1);
    const ip = { 'x-forwarded-for': '8.8.8.8' };
    keyAnswered('hk_test_aaa', 200);
    keyAnswered('hk_test_bbb', 204);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_aaa' })).status).toBe(200);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_bbb' })).status).toBe(200);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_aaa' })).status).toBe(429);
  });

  it('counts a token /v1 has never answered against the address, however many are invented', async () => {
    const app = appWith(2);
    const ip = { 'x-forwarded-for': '6.6.6.6' };
    expect((await hit(app, { ...ip, authorization: 'Bearer invented-1' })).status).toBe(200);
    expect((await hit(app, { ...ip, authorization: 'Bearer invented-2' })).status).toBe(200);
    expect((await hit(app, { ...ip, authorization: 'Bearer invented-3' })).status).toBe(429);
  });

  it('takes only a 2xx as proof of a key, and a 401 as proof against it', async () => {
    const app = appWith(1);
    const ip = { 'x-forwarded-for': '5.5.5.5' };
    // /v1's own limiter answers 429 before it looks at the key, and a 404 or a 500 says nothing of it either.
    for (const status of [429, 404, 500]) keyAnswered('hk_test_ccc', status);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_ccc' })).status).toBe(200); // the address's one request
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_ccc' })).status).toBe(429);
    keyAnswered('hk_test_ccc', 200);
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_ccc' })).status).toBe(200); // its own bucket now
    keyAnswered('hk_test_ccc', 401); // revoked or expired
    expect((await hit(app, { ...ip, authorization: 'Bearer hk_test_ccc' })).status).toBe(429); // back with the address
  });

  it('takes the RIGHT-MOST forwarded address, so a spoofed prefix cannot rotate the bucket', async () => {
    const app = appWith(1);
    // Same real client (appended last by the proxy), different attacker-supplied prefixes.
    expect((await hit(app, { 'x-forwarded-for': '1.1.1.1, 7.7.7.7' })).status).toBe(200);
    expect((await hit(app, { 'x-forwarded-for': '2.2.2.2, 7.7.7.7' })).status).toBe(429);
  });
});
