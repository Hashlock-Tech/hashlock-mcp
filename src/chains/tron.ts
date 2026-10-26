import { TronWeb } from 'tronweb';
import { encodePacked, keccak256 } from 'viem';
import type { OnchainEscrow } from '../settlement.js';

/**
 * TRON signing + SharedHTLC settlement for the autonomous agent (TronWeb, headless). The agent's
 * key authenticates (signMessageV2) and signs fund/claim. Host + shared-HTLC address come from the
 * API's GET /config.
 */
const FEE_LIMIT = 1_000_000_000;

const sharedAbi = [
  {
    type: 'function',
    // The v2 pool (one pool for every TRC-20 and native TRX): every escrow names its token.
    name: 'fund',
    stateMutability: 'payable',
    inputs: [
      { name: 'agreedId', type: 'bytes32' },
      { name: 'token', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'hashlock', type: 'bytes32' },
      { name: 'timelock', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'swapId', type: 'bytes32' },
      { name: 'secret', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'swapId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'swaps',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'initiator', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'hashlock', type: 'bytes32' },
      { name: 'timelock', type: 'uint256' },
      { name: 'claimed', type: 'bool' },
      { name: 'refunded', type: 'bool' },
    ],
  },
] as const;
const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** TRON's zero address — the `token` of a native-TRX escrow. */
const TRON_NATIVE_TOKEN = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

function hex32(v: string): string {
  const h = (v.startsWith('0x') ? v.slice(2) : v).toLowerCase().padStart(64, '0');
  return `0x${h}`;
}
/** TRON swapId = the swap UUID (dashes stripped) padded to 32 bytes — same derivation as the web. */
function swapIdFromUuid(uuid: string): string {
  return `0x${uuid.replace(/-/g, '')}${'0'.repeat(32)}`;
}

export interface TronChain {
  fullHost: string;
  /** The pool to FUND — null while the server hides it (a v1 pool awaiting rotation). */
  sharedHtlc: string | null;
  /** The configured pool whatever its version: the fallback for claim/refund of a leg with no recorded pool. */
  pool: string | null;
  apiKey?: string;
}

export class TronSigner {
  readonly address: string;
  private readonly key: string;
  constructor(privateKeyHex: string) {
    this.key = privateKeyHex.replace(/^0x/i, '');
    this.address = TronWeb.address.fromPrivateKey(this.key) as string;
  }

  private tw(chain: TronChain): TronWeb {
    return new TronWeb({
      fullHost: chain.fullHost,
      headers: chain.apiKey ? { 'TRON-PRO-API-KEY': chain.apiKey } : undefined,
      privateKey: this.key,
    });
  }

  async signLoginMessage(message: string, chain: TronChain): Promise<string> {
    return this.tw(chain).trx.signMessageV2(message);
  }

  async fund(
    chain: TronChain,
    p: {
      swapId: string; // db uuid
      recipient: string;
      amount: string;
      hashlockHex: string;
      timelockUnix: number;
      /** The TRC-20 address; null for native TRX (sent as the call value, nothing to approve). */
      token: string | null;
      fee: string;
    },
  ): Promise<string> {
    if (!chain.sharedHtlc) throw new Error('TRON funding is not available on this API right now (its pool is being rotated)');
    const tw = this.tw(chain);
    const total = BigInt(p.amount) + BigInt(p.fee);
    const shared = tw.contract(sharedAbi as unknown as never[], chain.sharedHtlc);
    const args = [swapIdFromUuid(p.swapId), p.token ?? TRON_NATIVE_TOKEN, p.recipient, p.amount, hex32(p.hashlockHex), p.timelockUnix, p.fee];
    if (!p.token) {
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount too large for a TRX call value');
      return shared.fund(...args).send({ feeLimit: FEE_LIMIT, callValue: Number(total) });
    }
    const token = tw.contract(erc20Abi as unknown as never[], p.token);
    await token.approve(chain.sharedHtlc, total.toString()).send({ feeLimit: FEE_LIMIT });
    return shared.fund(...args).send({ feeLimit: FEE_LIMIT });
  }

  /**
   * Take a funded slot back after its timelock. The pool refuses before it, so the chain is the gate.
   * `pool` is the pool the leg was FUNDED in (the leg's htlcAddress) — after a rotation the configured
   * pool is a newer one, where this escrow does not exist.
   */
  async refund(chain: TronChain, onchainSwapId: string, pool = chain.pool): Promise<string> {
    if (!pool) throw new Error('TRON pool unknown');
    const tw = this.tw(chain);
    const shared = tw.contract(sharedAbi as unknown as never[], pool);
    return shared.refund(hex32(onchainSwapId)).send({ feeLimit: FEE_LIMIT });
  }

  /**
   * A pool slot as the chain holds it (tester 3.4) — the caller has already checked `pool` is pinned. The
   * slot must be the one THIS swap's funding derives — slotOf(agreed id, funder, token, fee) — so one
   * escrow cannot be passed off as the initiator's leg of two swaps sharing a hashlock.
   */
  async readSlot(chain: TronChain, pool: string, onchainSwapId: string, swapUuid: string, fee: bigint): Promise<OnchainEscrow> {
    const shared = this.tw(chain).contract(sharedAbi as unknown as never[], pool);
    const r = (await shared.swaps(hex32(onchainSwapId)).call()) as Record<string, unknown>;
    if (BigInt(String(r.amount)) === 0n) throw new Error(`no escrow at slot ${onchainSwapId} of ${pool}`);
    const evm = (a: unknown) => `0x${TronWeb.address.toHex(TronWeb.address.fromHex(String(a))).slice(2)}` as `0x${string}`;
    const slot = keccak256(
      encodePacked(['bytes32', 'address', 'address', 'uint256'], [swapIdFromUuid(swapUuid) as `0x${string}`, evm(r.initiator), evm(r.token), fee]),
    );
    if (slot !== hex32(onchainSwapId)) throw new Error(`slot ${onchainSwapId} is not this swap's escrow`);
    const token = TronWeb.address.fromHex(String(r.token));
    return {
      hashlock: String(r.hashlock).replace(/^0x/i, '').toLowerCase(),
      recipient: TronWeb.address.fromHex(String(r.recipient)),
      token: token === TRON_NATIVE_TOKEN ? null : token,
      amount: BigInt(String(r.amount)),
      timelock: Number(String(r.timelock)),
      open: !r.claimed && !r.refunded,
    };
  }

  /** Whether this agent's slot for the swap — slotOf(agreed id, this key, token, fee) — already holds an escrow. */
  async fundedSlot(chain: TronChain, pool: string, swapUuid: string, token: string | null, fee: bigint): Promise<boolean> {
    const evm = (a: string) => `0x${TronWeb.address.toHex(a).slice(2)}` as `0x${string}`;
    const slot = keccak256(
      encodePacked(['bytes32', 'address', 'address', 'uint256'], [swapIdFromUuid(swapUuid) as `0x${string}`, evm(this.address), evm(token ?? TRON_NATIVE_TOKEN), fee]),
    );
    const r = (await this.tw(chain).contract(sharedAbi as unknown as never[], pool).swaps(slot).call()) as Record<string, unknown>;
    return BigInt(String(r.amount)) > 0n;
  }

  /** Claim to the recipient fixed at funding. `pool`: as for refund. */
  async claim(chain: TronChain, onchainSwapId: string, secretHex: string, pool = chain.pool): Promise<string> {
    if (!pool) throw new Error('TRON pool unknown');
    const tw = this.tw(chain);
    const shared = tw.contract(sharedAbi as unknown as never[], pool);
    return shared.claim(hex32(onchainSwapId), hex32(secretHex)).send({ feeLimit: FEE_LIMIT });
  }
}
