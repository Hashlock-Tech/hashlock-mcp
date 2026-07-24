import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../secrets.js';

describe('SecretStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-mcp-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('generates a 32-byte hex secret whose sha256 is the hashlock (stack-wide convention)', () => {
    const store = new SecretStore(join(dir, 's.json'));
    const { secret, hashlock } = store.generate('thread-1');
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // bare hex, no 0x — matches web + API
    expect(hashlock).toBe(createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex'));
  });

  it('is idempotent per thread and persists across instances', () => {
    const path = join(dir, 's.json');
    const a = new SecretStore(path).generate('t1');
    const b = new SecretStore(path).generate('t1');
    expect(b.secret).toBe(a.secret);
    expect(new SecretStore(path).get('t1')?.hashlock).toBe(a.hashlock);
    expect(new SecretStore(path).get('missing')).toBeNull();
  });

  it('different threads get different secrets', () => {
    const store = new SecretStore(join(dir, 's.json'));
    expect(store.generate('t1').secret).not.toBe(store.generate('t2').secret);
  });
});
