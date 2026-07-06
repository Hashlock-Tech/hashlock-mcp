import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Local store for atomic-swap secrets (preimages). The secret is generated HERE, on the agent's
 * machine, and never sent to the API — only its sha256 (the hashlock) is. The initiator needs the
 * preimage later to claim their receive leg, so it persists keyed by threadId (same convention as
 * the web app's localStorage `hl.secret.<threadId>`). Format matches the whole stack: bare hex,
 * 32 bytes, sha256 hashlock (Bitcoin Script compatible).
 */
export interface StoredSecret {
  secret: string; // 64-char hex preimage — keep private
  hashlock: string; // sha256(secret), 64-char hex
  createdAt: string;
}

export class SecretStore {
  constructor(private readonly path: string) {}

  private load(): Record<string, StoredSecret> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, StoredSecret>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, StoredSecret>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  /** Generate (or return the existing) secret for a thread. Idempotent per thread. */
  generate(threadId: string): StoredSecret {
    const all = this.load();
    const existing = all[threadId];
    if (existing) return existing;
    const secret = randomBytes(32).toString('hex');
    const hashlock = createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
    const entry: StoredSecret = { secret, hashlock, createdAt: new Date().toISOString() };
    all[threadId] = entry;
    this.save(all);
    return entry;
  }

  get(threadId: string): StoredSecret | null {
    return this.load()[threadId] ?? null;
  }
}
