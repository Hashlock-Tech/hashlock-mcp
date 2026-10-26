import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import type { OnchainEscrow } from '../settlement.js';

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
 *
 * WHAT IS CHECKED BEFORE SIGNING (tester 3.4), when settlement passes a `pin`: every top-level
 * instruction is decoded. It must be exactly one HTLC instruction of the kind asked for, on a program
 * pinned for the agent's own cluster, plus at most a compute-unit price under the API's own ceiling — so
 * no transfer can ride along. In that instruction the accounts that decide whose money moves are the ones
 * the agent expects: itself as funder (fund, refund) or recipient (claim), the escrow it checked on chain
 * (claim, refund), the agreed mint. A fund's arguments — swap id, hashlock, recipient, amount, timelock,
 * fee — must be the agent's own leg; the program refuses a `terms` hash that does not cover them, and the
 * escrow address is a PDA of those terms, so binding the arguments binds the escrow.
 */

/** Sets the priority fee every server-built settlement transaction carries. */
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** The API's PRIORITY_CEIL_MICRO_LAMPORTS (chains/solana/priority.ts). */
const MAX_MICRO_LAMPORTS_PER_CU = 1_000_000n;

/** The HTLC program's instruction discriminators per settlement action (its committed IDL): [token, native]. */
export const HTLC_INSTRUCTIONS = {
  fund: ['dabc6fdd9871ae07', '9c81db22a1d6e738'], // fund, fund_sol
  claim: ['3ec6d6c1d59f6cd2', '8b71b3bdbe1e84c3'], // claim, claim_sol
  refund: ['0260b7fb3fd02e2e', '9e4483726a4d380d'], // refund, refund_sol
} as const;

type HtlcAction = keyof typeof HTLC_INSTRUCTIONS;

/**
 * Where each instruction names the accounts that decide whose money moves (the committed IDL's account
 * order): `self` is the agent's role — funder on fund and refund, recipient on claim — `escrow` the escrow,
 * `mint` the SPL mint on the token path.
 *   fund       [funder, escrow, escrow_ata, funder_ata, treasury_ata, config, mint, …]
 *   fund_sol   [funder, escrow, treasury, config, system_program]
 *   claim      [payer, escrow, escrow_ata, recipient, recipient_ata, mint, …]
 *   claim_sol  [payer, escrow, recipient]
 *   refund     [payer, funder, escrow, escrow_ata, funder_ata, mint, …]
 *   refund_sol [payer, funder, escrow]
 */
const SLOTS: Record<string, { action: HtlcAction; native: boolean; self: number; escrow: number; mint?: number }> = {
  [HTLC_INSTRUCTIONS.fund[0]]: { action: 'fund', native: false, self: 0, escrow: 1, mint: 6 },
  [HTLC_INSTRUCTIONS.fund[1]]: { action: 'fund', native: true, self: 0, escrow: 1 },
  [HTLC_INSTRUCTIONS.claim[0]]: { action: 'claim', native: false, self: 3, escrow: 1, mint: 5 },
  [HTLC_INSTRUCTIONS.claim[1]]: { action: 'claim', native: true, self: 2, escrow: 1 },
  [HTLC_INSTRUCTIONS.refund[0]]: { action: 'refund', native: false, self: 1, escrow: 2, mint: 5 },
  [HTLC_INSTRUCTIONS.refund[1]]: { action: 'refund', native: true, self: 1, escrow: 2 },
};

/** What a server-built settlement transaction must be, beyond the escrow it mentions. */
export interface SolanaPin {
  /** The HTLC programs it may call — the pinned ones for the agent's own cluster. */
  programs: readonly string[];
  action: HtlcAction;
  /** The escrow account the HTLC call must name (claim/refund: the escrow the agent checked). */
  escrow?: string;
  /** The mint the leg is in (null = native SOL), when the agent knows it. */
  mint?: string | null;
  /** Fund only: the leg as the agent knows it. */
  fund?: FundTerms;
  /** Claim only: addresses besides this key the claim may pay — ones this MCP set for the leg. */
  recipients?: readonly string[];
}

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

  /**
   * Sign a server-built transaction. In and out are base64, which is what /tx/broadcast takes.
   *
   * @param escrow the escrow address the server said this transaction settles. Required, because it is
   *   the only check standing between this signer and a transfer draining the agent's wallet.
   * @param pin when given (tester 3.4): the transaction must be one call of `instructions` (Anchor
   *   discriminators, hex) on one of `programs`, plus at most a capped compute-unit price. With `fund`,
   *   that call's arguments must be these terms — the agent's own leg as it knows it.
   */
  signTransaction(
    transactionBase64: string,
    escrow: string,
    pin?: SolanaPin,
  ): string {
    const tx = Buffer.from(transactionBase64, 'base64');
    const { value: sigCount, next: sigStart } = readCompactU16(tx, 0);
    if (sigCount !== 1) throw new Error(`expected a single-signature transaction, got ${sigCount} slots`);
    const message = tx.subarray(sigStart + 64);
    // Skip the version byte a v0 message starts with (high bit set), then the three header counts, then
    // the key-array length. What follows is `count` × 32 bytes of static account keys.
    const afterVersion = message[0] !== undefined && (message[0] & 0x80) !== 0 ? 1 : 0;
    const { value: keyCount, next: keysAt } = readCompactU16(message, afterVersion + 3);
    const keyAt = (i: number): Buffer => message.subarray(keysAt + i * 32, keysAt + i * 32 + 32);
    if (keysAt + keyCount * 32 > message.length) throw new Error('transaction ended inside its account keys');

    if (!keyAt(0).equals(this.pubkey)) {
      throw new Error(`this transaction must be signed by ${base58Encode(keyAt(0))}, not ${this.address}`);
    }
    // NOT the instruction count, deliberately: a priority fee adds a compute-budget instruction, so a
    // count here would break the day the keeper grows one. The escrow's PRESENCE is what matters.
    const wantEscrow = base58Decode(escrow);
    let touchesEscrow = false;
    for (let i = 0; i < keyCount; i++) if (keyAt(i).equals(wantEscrow)) touchesEscrow = true;
    if (!touchesEscrow) {
      throw new Error(`refusing to sign: this transaction never mentions escrow ${escrow}`);
    }
    if (pin) {
      // EVERY top-level instruction, not the key list: a key can sit there unused beside a transfer out of
      // this wallet. The server's settlement transaction is a compute-unit price plus ONE HTLC call of the
      // kind asked for — a second one could be a fund of the agent's money into someone else's escrow.
      const programs = pin.programs.map((p) => base58Decode(p));
      const budget = base58Decode(COMPUTE_BUDGET);
      let htlcCalls = 0;
      let at = keysAt + keyCount * 32 + 32; // past the static keys and the recent blockhash
      const { value: ixCount, next } = readCompactU16(message, at);
      at = next;
      for (let n = 0; n < ixCount; n++) {
        const programIndex = message[at++];
        if (programIndex === undefined || programIndex >= keyCount) throw new Error('refusing to sign: an instruction names a program outside the transaction');
        const accounts = readCompactU16(message, at);
        const accountIndexes = message.subarray(accounts.next, accounts.next + accounts.value);
        const dataLen = readCompactU16(message, accounts.next + accounts.value);
        const data = message.subarray(dataLen.next, dataLen.next + dataLen.value);
        at = dataLen.next + dataLen.value;
        if (at > message.length) throw new Error('transaction ended inside an instruction');
        const program = keyAt(programIndex);
        if (program.equals(budget)) {
          // SetComputeUnitPrice only, at no more than the API's own ceiling: a limit or a price above it is a
          // fee big enough to drain the wallet to the leader.
          if (data.length !== 9 || data[0] !== 3 || data.readBigUInt64LE(1) > MAX_MICRO_LAMPORTS_PER_CU) {
            throw new Error('refusing to sign: this transaction sets a compute budget beyond the priority price the API uses');
          }
        } else if (programs.some((p) => program.equals(p)) && SLOTS[data.subarray(0, 8).toString('hex')]?.action === pin.action) {
          htlcCalls++;
          const slots = SLOTS[data.subarray(0, 8).toString('hex')]!;
          const account = (i: number | undefined) => {
            const k = i === undefined ? undefined : accountIndexes[i];
            return k === undefined || k >= keyCount ? null : keyAt(k);
          };
          // Whose money moves is decided by these accounts, so each is the one the agent expects.
          const self = account(slots.self);
          const allowed = [this.pubkey, ...(pin.action === 'claim' ? (pin.recipients ?? []).map((r) => base58Decode(r)) : [])];
          if (!self || !allowed.some((k) => self.equals(k))) throw new Error(`refusing to sign: the ${pin.action} instruction does not name this agent where it must`);
          if (pin.escrow && !account(slots.escrow)?.equals(base58Decode(pin.escrow))) {
            throw new Error(`refusing to sign: the ${pin.action} instruction acts on another escrow than ${pin.escrow}`);
          }
          if (pin.mint !== undefined) {
            if (slots.native !== (pin.mint === null)) throw new Error(`refusing to sign: the ${pin.action} instruction is for ${slots.native ? 'native SOL' : 'a token'}, not the agreed asset`);
            if (pin.mint !== null && !account(slots.mint)?.equals(base58Decode(pin.mint))) throw new Error(`refusing to sign: the ${pin.action} instruction is for another mint than ${pin.mint}`);
          }
          if (pin.fund) {
            const problem = fundTermsProblem(data, pin.fund);
            if (problem) throw new Error(`refusing to sign: the fund instruction ${problem}`);
          }
        } else {
          throw new Error('refusing to sign: this transaction calls something other than the Hashlock HTLC instruction asked for');
        }
      }
      if (htlcCalls !== 1) throw new Error(`refusing to sign: expected one HTLC instruction, found ${htlcCalls}`);
    }

    const signature = edSign(null, message, this.key);
    return Buffer.concat([tx.subarray(0, sigStart), signature, message]).toString('base64');
  }

  /** Sign a login/link message. base58, which is what POST /me/link-solana verifies. */
  signLoginMessage(message: string): string {
    return base58Encode(edSign(null, Buffer.from(message, 'utf8'), this.key));
  }
}

/** The agent's own leg, as it knows it, that a server-built fund instruction must carry. */
export interface FundTerms {
  swapId: string; // uuid
  hashlock: string; // hex
  recipient: string; // base58
  amount: bigint;
  timelock: number;
  fee: bigint;
}

/**
 * Why a `fund`/`fund_sol` call is not the agreed one (tester 3.4), or null. Args, after the 8-byte
 * discriminator, per the committed IDL: swap_id [16], terms [32], hashlock [32], recipient, amount u64,
 * timelock i64, fee u64 — the program refuses `terms` unless it hashes these, so the args are what bind.
 * The accounts (funder, mint) are checked with every other instruction's, by SLOTS.
 */
function fundTermsProblem(data: Buffer, want: FundTerms): string | null {
  if (data.length !== 144) return `has ${data.length} bytes of data, not the 144 the IDL lays out`;
  if (data.subarray(8, 24).toString('hex') !== want.swapId.replace(/-/g, '').toLowerCase()) return 'is for another swap';
  if (data.subarray(56, 88).toString('hex') !== want.hashlock.replace(/^0x/i, '').toLowerCase()) return 'carries another hashlock';
  if (!data.subarray(88, 120).equals(base58Decode(want.recipient))) return `pays ${base58Encode(data.subarray(88, 120))}, not ${want.recipient}`;
  if (data.readBigUInt64LE(120) !== want.amount) return `locks ${data.readBigUInt64LE(120)}, not the agreed ${want.amount}`;
  if (data.readBigInt64LE(128) !== BigInt(want.timelock)) return `has timelock ${data.readBigInt64LE(128)}, not your leg's ${want.timelock}`;
  if (data.readBigUInt64LE(136) !== want.fee) return `pays a fee of ${data.readBigUInt64LE(136)}, not ${want.fee}`;
  return null;
}

/** Anchor's account discriminator for the program's `Escrow`. */
const ESCROW_DISCRIMINATOR = createHash('sha256').update('account:Escrow').digest().subarray(0, 8);

/**
 * The program's `Escrow` account (programs/hashlock-htlc lib.rs): discriminator, swap_id [16], hashlock,
 * recipient, funder, mint (all-zero = native SOL), amount u64, timelock i64, fee u64, state u8 (0 =
 * Funded), bump, terms. Only meaningful for an account OWNED by one of our programs — the caller checks.
 */
export function decodeSolanaEscrow(data: Buffer, swapId: string): OnchainEscrow {
  if (data.length < 8 + 16 + 32 * 4 + 24 + 2 || !data.subarray(0, 8).equals(ESCROW_DISCRIMINATOR)) {
    throw new Error('this account is not an HTLC escrow');
  }
  if (data.subarray(8, 24).toString('hex') !== swapId.replace(/-/g, '').toLowerCase()) {
    throw new Error('this escrow belongs to another swap');
  }
  const key = (at: number) => data.subarray(at, at + 32);
  const mint = key(120);
  return {
    hashlock: key(24).toString('hex'),
    recipient: base58Encode(key(56)),
    token: mint.every((b) => b === 0) ? null : base58Encode(mint),
    amount: data.readBigUInt64LE(152),
    timelock: Number(data.readBigInt64LE(160)),
    open: data[176] === 0,
  };
}

/** Read an escrow account through `rpcUrl`; it must be owned by one of `programs`. */
export async function readSolanaEscrow(rpcUrl: string, escrow: string, swapId: string, programs: readonly string[]): Promise<OnchainEscrow> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [escrow, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
  const json = (await res.json()) as { result?: { value: { owner: string; data: [string, string] } | null }; error?: { message: string } };
  if (json.error) throw new Error(`Solana RPC: ${json.error.message}`);
  const acc = json.result?.value;
  if (!acc) throw new Error(`no account at ${escrow} (is HASHLOCK_SOLANA_RPC on the right cluster?)`);
  if (!programs.includes(acc.owner)) throw new Error(`${escrow} belongs to ${acc.owner}, not a Hashlock HTLC program this release knows`);
  return decodeSolanaEscrow(Buffer.from(acc.data[0], 'base64'), swapId);
}

/** Whether `address` holds an account on the cluster `rpcUrl` answers for. */
export async function solanaAccountExists(rpcUrl: string, address: string): Promise<boolean> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
  const json = (await res.json()) as { result?: { value: unknown }; error?: { message: string } };
  if (json.error) throw new Error(`Solana RPC: ${json.error.message}`);
  return json.result?.value != null;
}
