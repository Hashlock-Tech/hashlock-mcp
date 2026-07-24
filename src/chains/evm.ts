import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * EVM signing + HTLC settlement for the autonomous agent (viem, headless). The agent's key both
 * authenticates (SIWE personal_sign) and signs the on-chain fund/claim. Chain params (RPC, factory,
 * chainId) come from the API's GET /config, so nothing is hardcoded.
 */
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const factoryAbi = [
  {
    type: 'function',
    name: 'createSwap',
    stateMutability: 'payable',
    inputs: [
      { name: 'salt', type: 'bytes32' },
      { name: 'hashlock', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'timelock', type: 'uint256' },
      { name: 'initiator', type: 'address' },
      { name: 'fee', type: 'uint256' },
    ],
    outputs: [{ name: 'clone', type: 'address' }],
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
const htlcAbi = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'secret', type: 'bytes32' }], outputs: [] },
] as const;

export interface EvmChain {
  rpcUrl: string;
  chainId: number;
  factory: Address;
}

export class EvmSigner {
  readonly account;
  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
  }
  get address(): Address {
    return this.account.address;
  }
  signLoginMessage(message: string): Promise<string> {
    return this.account.signMessage({ message });
  }

  private clients(chain: EvmChain) {
    const def = { id: chain.chainId, name: `evm-${chain.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } } as const;
    const wallet = createWalletClient({ account: this.account, chain: def, transport: http(chain.rpcUrl) });
    const pub = createPublicClient({ chain: def, transport: http(chain.rpcUrl) });
    return { wallet, pub };
  }

  /** Create + fund the HTLC clone. salt = keccak256(uuid) (same derivation as the web). */
  async fund(
    chain: EvmChain,
    p: {
      swapId: string;
      hashlockHex: string;
      recipient: Address;
      refund: Address;
      token: Address | null;
      amount: bigint;
      timelockUnix: number;
      fee: bigint;
    },
  ): Promise<string> {
    const { wallet, pub } = this.clients(chain);
    const salt = keccak256(toHex(p.swapId));
    const token = p.token ?? ZERO;

    if (p.token) {
      const approveTx = await wallet.sendTransaction({
        to: p.token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [chain.factory, p.amount + p.fee] }),
      });
      await pub.waitForTransactionReceipt({ hash: approveTx });
    }

    const data = encodeFunctionData({
      abi: factoryAbi,
      functionName: 'createSwap',
      args: [salt, `0x${p.hashlockHex}`, p.recipient, token, p.amount, BigInt(p.timelockUnix), p.refund, p.fee],
    });
    const hash = await wallet.sendTransaction({
      to: chain.factory,
      data,
      value: p.token ? 0n : p.amount + p.fee,
    });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Claim a funded clone with the preimage (reveals the secret on-chain). */
  async claim(chain: EvmChain, clone: Address, secretHex: string): Promise<string> {
    const { wallet, pub } = this.clients(chain);
    const data = encodeFunctionData({ abi: htlcAbi, functionName: 'claim', args: [`0x${secretHex.replace(/^0x/, '')}`] });
    const hash = await wallet.sendTransaction({ to: clone, data });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  }
}
