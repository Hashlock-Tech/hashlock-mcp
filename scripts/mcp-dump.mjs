#!/usr/bin/env node
// Dumps what a 2025-06-18 client sees from both built servers: `initialize` and `tools/list` from the stdio server, and
// from the hosted one for a developer key and for an OAuth (chat assistant) key. Run it before and after an SDK change
// and diff the two outputs. Needs `pnpm build`. No credentials: the API URLs point at a closed port and nothing is called.
//   node scripts/mcp-dump.mjs > before.json
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(`${tmpdir()}/mcp-dump-`);
const env = { PATH: process.env.PATH, HOME: home, HASHLOCK_API_URL: 'http://127.0.0.1:9/api', HASHLOCK_V1_URL: 'http://127.0.0.1:9/v1' };
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-dump', version: '0' } };

/** Key order is not part of the protocol; sort it so the diff shows only what a client can tell apart. */
const canonical = (v) =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;

/** Runs `work` against `child` and kills the child after: it fails if the child exits first, or after 30 s. */
async function talkTo(child, work) {
  let timer;
  const exited = new Promise((_, reject) => child.once('exit', (code, signal) => reject(new Error(`${child.spawnargs[1]} exited (${signal ?? code})`))));
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${child.spawnargs[1]}: no answer in 30 s`)), 30_000)));
  try {
    return await Promise.race([work(), exited, late]);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function stdio() {
  const child = spawn(process.execPath, [`${root}dist/index.js`], { cwd: '/', env, stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      replies.get(m.id)?.(m);
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return talkTo(child, async () => {
    const initialize = await rpc(1, 'initialize', INIT);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return { initialize, toolsList: await rpc(2, 'tools/list', {}) };
  });
}

async function hosted() {
  const port = await new Promise((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
  const child = spawn(process.execPath, [`${root}dist/http/index.js`], { cwd: '/', env: { ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  const rpc = async (token, method, params) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    const data = text.split('\n').find((l) => l.startsWith('data: '));
    return { status: res.status, contentType: res.headers.get('content-type'), body: JSON.parse(data ? data.slice(6) : text) };
  };
  return talkTo(child, async () => {
    await new Promise((r) => child.stderr.on('data', (d) => String(d).includes('ready') && r()));
    const out = {};
    for (const [kind, token] of [['developer', 'hk_live_dump'], ['assistant', 'hk_oa_live_dump']])
      out[kind] = { initialize: await rpc(token, 'initialize', INIT), toolsList: await rpc(token, 'tools/list', {}) };
    return out;
  });
}

process.stdout.write(JSON.stringify(canonical({ stdio: await stdio(), hosted: await hosted() }), null, 2) + '\n');
