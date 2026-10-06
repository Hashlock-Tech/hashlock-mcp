import { TronWeb } from 'tronweb';

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
    this.key = privateKeyHex.replace(/^0x/, '');
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

  /** Claim to the recipient fixed at funding. `pool`: as for refund. */
  async claim(chain: TronChain, onchainSwapId: string, secretHex: string, pool = chain.pool): Promise<string> {
    if (!pool) throw new Error('TRON pool unknown');
    const tw = this.tw(chain);
    const shared = tw.contract(sharedAbi as unknown as never[], pool);
    return shared.claim(hex32(onchainSwapId), hex32(secretHex)).send({ feeLimit: FEE_LIMIT });
  }
}
