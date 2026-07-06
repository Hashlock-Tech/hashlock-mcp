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
    name: 'fund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'swapId', type: 'bytes32' },
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
  sharedHtlc: string;
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
      token: string;
      fee: string;
    },
  ): Promise<string> {
    const tw = this.tw(chain);
    const total = (BigInt(p.amount) + BigInt(p.fee)).toString();
    const token = tw.contract(erc20Abi as unknown as never[], p.token);
    await token.approve(chain.sharedHtlc, total).send({ feeLimit: FEE_LIMIT });
    const shared = tw.contract(sharedAbi as unknown as never[], chain.sharedHtlc);
    return shared
      .fund(swapIdFromUuid(p.swapId), p.recipient, p.amount, hex32(p.hashlockHex), p.timelockUnix, p.fee)
      .send({ feeLimit: FEE_LIMIT });
  }

  async claim(chain: TronChain, onchainSwapId: string, secretHex: string): Promise<string> {
    const tw = this.tw(chain);
    const shared = tw.contract(sharedAbi as unknown as never[], chain.sharedHtlc);
    return shared.claim(hex32(onchainSwapId), hex32(secretHex)).send({ feeLimit: FEE_LIMIT });
  }
}
