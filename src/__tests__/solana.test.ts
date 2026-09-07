import { createPublicKey, verify as edVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SolanaSigner, base58Decode, base58Encode } from '../chains/solana.js';

/**
 * The fixtures are REAL transactions, serialized by @solana/web3.js in packages/api of the markets
 * repo — not ones shaped to match this parser's assumptions, which would test nothing. Keypair is the
 * all-sevens seed, so it is reproducible: Keypair.fromSeed(Buffer.alloc(32, 7)).
 */
const SECRET = '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM';
const PUB = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const LEGACY =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iz9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgIAAQwCAAAAAQAAAAAAAAA=';
const V0 =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABA+pKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAAEMAgAAAAEAAAAAAAAAAA==';
/** Same shape, but the OTHER key pays — so slot 0 is not ours. */
const OTHER_PAYER =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAED/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hjqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgIAAQwCAAAAAQAAAAAAAAA=';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
/** Account key 1 of the fixtures — a real key in the transaction, standing in for the escrow. */
const IN_TX = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf';
const NOT_IN_TX = 'So11111111111111111111111111111111111111112';

/** Does the signature in slot 0 actually open under `PUB` for the message it covers? */
function slotZeroVerifies(base64: string, pubB58: string): boolean {
  const tx = Buffer.from(base64, 'base64');
  const sig = tx.subarray(1, 65); // one-byte count for a single slot
  const message = tx.subarray(65);
  const key = createPublicKey({ key: Buffer.concat([SPKI, base58Decode(pubB58)]), format: 'der', type: 'spki' });
  return edVerify(null, message, key, sig);
}

describe('base58', () => {
  it('round-trips, leading zeros included', () => {
    for (const hex of ['00', '0000ff', 'ff', '00112233445566778899aabbccddeeff']) {
      const bytes = Buffer.from(hex, 'hex');
      expect(base58Decode(base58Encode(bytes)).toString('hex')).toBe(hex);
    }
  });
});

describe('SolanaSigner', () => {
  it('derives the public key from the seed rather than trusting the input', () => {
    expect(new SolanaSigner(SECRET).address).toBe(PUB);
    // A bare 32-byte seed must give the same identity as the 64-byte export it came from.
    expect(new SolanaSigner(base58Encode(base58Decode(SECRET).subarray(0, 32))).address).toBe(PUB);
  });

  it('signs a legacy transaction so slot 0 verifies, without changing its length', () => {
    const s = new SolanaSigner(SECRET);
    const signed = s.signTransaction(LEGACY, IN_TX);
    expect(Buffer.from(signed, 'base64')).toHaveLength(Buffer.from(LEGACY, 'base64').length);
    expect(slotZeroVerifies(LEGACY, PUB)).toBe(false); // the fixture is unsigned: zeroed slot
    expect(slotZeroVerifies(signed, PUB)).toBe(true);
  });

  it('signs a v0 transaction too — the version byte must not be read as a header', () => {
    const signed = new SolanaSigner(SECRET).signTransaction(V0, IN_TX);
    expect(slotZeroVerifies(signed, PUB)).toBe(true);
  });

  it('refuses a transaction whose first account key is somebody else', () => {
    // The failure this prevents is silent otherwise: a signature in the wrong slot is bytes the chain
    // rejects for a missing signature, after the agent has already paid to broadcast them.
    expect(() => new SolanaSigner(SECRET).signTransaction(OTHER_PAYER, IN_TX)).toThrow(/must be signed by/);
  });

  it('refuses a transaction that wants more than one signature', () => {
    const tx = Buffer.from(LEGACY, 'base64');
    const two = Buffer.concat([Buffer.from([2]), Buffer.alloc(64), tx.subarray(1)]);
    expect(() => new SolanaSigner(SECRET).signTransaction(two.toString('base64'), IN_TX)).toThrow(/single-signature/);
  });

  it('refuses a transaction that never mentions the escrow it claims to settle', () => {
    // The floor under "sign what the server built": one signature and the agent as payer is also the
    // shape of a transfer emptying this wallet, and a drain cannot name the escrow and still drain.
    expect(() => new SolanaSigner(SECRET).signTransaction(LEGACY, NOT_IN_TX)).toThrow(/never mentions escrow/);
  });

  it('refuses a key that is neither 32 nor 64 bytes', () => {
    expect(() => new SolanaSigner(base58Encode(Buffer.alloc(31, 1)))).toThrow(/32 or 64 bytes/);
  });
});
