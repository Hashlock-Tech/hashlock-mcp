import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

/**
 * Signing a Solana leg, WITHOUT a chain SDK.
 *
 * The server builds every Solana transaction (routes/settlement-legs.ts) and hands back base64; this
 * file's whole job is to put one ed25519 signature into it. That is a few lines of wire format plus
 * node:crypto, so @solana/web3.js — which drags in an RPC and a websocket client — stays out of a
 * package other people install. The API verifies Solana logins the same way, for the same reason.
 *
 * WHAT IT REFUSES TO GUESS. A transaction is `[compact-u16 count][64-byte signatures][message]`, and
 * the signature at slot i belongs to account key i. Every settlement transaction we are handed needs
 * exactly one signature — the fee payer, which the server fixes to this leg's own funder or recipient —
 * so slot 0 is ours. Both halves of that are CHECKED rather than assumed: the count must be 1, and
 * account key 0 must be this key. A transaction shaped differently is refused, because signing the
 * wrong slot produces bytes the chain rejects for a missing signature after the agent has spent a fee.
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** PKCS8 wrapper for a raw 32-byte ed25519 seed — node:crypto has no raw-key import. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out; // leading zero bytes carry no magnitude, and base58 spells each as '1'
  }
  return out;
}

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`not base58: ${ch}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n));
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** compact-u16 (Solana's "short vec" length): 7 bits per byte, high bit continues. */
function readCompactU16(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let i = at;
  for (let shift = 0; ; shift += 7) {
    const byte = buf[i++];
    if (byte === undefined) throw new Error('transaction ended inside a length');
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    if (shift >= 21) throw new Error('compact-u16 too long');
  }
  return { value, next: i };
}

export class SolanaSigner {
  readonly address: string;
  private readonly key: ReturnType<typeof createPrivateKey>;
  private readonly pubkey: Buffer;

  /**
   * @param secretKey base58 — either the 64-byte keypair every Solana wallet exports, or a bare
   *   32-byte seed. The last 32 bytes of a 64-byte export are the PUBLIC key, not more secret, so
   *   taking the first 32 as the seed is correct rather than lossy.
   */
  constructor(secretKey: string) {
    const raw = base58Decode(secretKey.trim());
    if (raw.length !== 64 && raw.length !== 32) {
      throw new Error(`HASHLOCK_SOLANA_KEY must decode to 32 or 64 bytes, got ${raw.length}`);
    }
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    // The public half is derived, never read from the input: a 64-byte export whose tail does not match
    // its own seed would otherwise make this agent announce an address it cannot sign for.
    this.pubkey = createPublicKey(this.key).export({ format: 'der', type: 'spki' }).subarray(-32);
    this.address = base58Encode(this.pubkey);
  }

  /** Sign a server-built transaction. In and out are base64, which is what /tx/broadcast takes. */
  signTransaction(transactionBase64: string): string {
    const tx = Buffer.from(transactionBase64, 'base64');
    const { value: sigCount, next: sigStart } = readCompactU16(tx, 0);
    if (sigCount !== 1) throw new Error(`expected a single-signature transaction, got ${sigCount} slots`);
    const message = tx.subarray(sigStart + 64);
    // Account key 0 must be us. Skip the version byte a v0 message starts with (high bit set), then the
    // three header counts, then the key-array length.
    const afterVersion = message[0] !== undefined && (message[0] & 0x80) !== 0 ? 1 : 0;
    const { next: keysAt } = readCompactU16(message, afterVersion + 3);
    const firstKey = message.subarray(keysAt, keysAt + 32);
    if (!firstKey.equals(this.pubkey)) {
      throw new Error(`this transaction must be signed by ${base58Encode(firstKey)}, not ${this.address}`);
    }
    const signature = edSign(null, message, this.key);
    return Buffer.concat([tx.subarray(0, sigStart), signature, message]).toString('base64');
  }
}
