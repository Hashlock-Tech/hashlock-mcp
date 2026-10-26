import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { OnchainEscrow } from '../settlement.js';

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
  { type: 'function', name: 'refund', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

const view = (name: string, type: string) =>
  ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ name: '', type }] }) as const;
const cloneAbi = [
  view('hashlock', 'bytes32'),
  view('recipient', 'address'),
  view('token', 'address'),
  view('amount', 'uint256'),
  view('timelock', 'uint256'),
  view('initiator', 'address'),
  view('claimed', 'bool'),
  view('refunded', 'bool'),
];
const computeAddressAbi = [
  { ...factoryAbi[0], name: 'computeAddress', stateMutability: 'view', outputs: [{ name: '', type: 'address' }] },
] as const;
const balanceOfAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * READ A CLONE FROM THE CHAIN, not from the API (tester 3.4). Its getters are only worth anything if the
 * code behind them is our implementation, so the clone must be the address one of `factories` (pinned
 * for this chain id) derives from those very terms — CREATE2 binds them. Its amount is what it actually
 * holds, since the clone pays out its whole balance.
 */
export async function readEvmEscrow(
  chain: Pick<EvmChain, 'rpcUrl' | 'chainId'>,
  clone: Address,
  swapId: string,
  fee: bigint,
  factories: readonly string[],
): Promise<OnchainEscrow> {
  const pub = createPublicClient({ transport: http(chain.rpcUrl) });
  const onChain = await pub.getChainId();
  if (onChain !== chain.chainId) throw new Error(`the RPC answers for chain ${onChain}, not ${chain.chainId}`);
  const get = <T>(functionName: string) => pub.readContract({ address: clone, abi: cloneAbi, functionName }) as Promise<T>;
  const [hashlock, recipient, token, amount, timelock, initiator, claimed, refunded] = await Promise.all([
    get<`0x${string}`>('hashlock'),
    get<Address>('recipient'),
    get<Address>('token'),
    get<bigint>('amount'),
    get<bigint>('timelock'),
    get<Address>('initiator'),
    get<boolean>('claimed'),
    get<boolean>('refunded'),
  ]);
  let ours = false;
  for (const factory of factories) {
    const at = await pub
      .readContract({
        address: factory as Address,
        abi: computeAddressAbi,
        functionName: 'computeAddress',
        args: [keccak256(toHex(swapId)), hashlock, recipient, token, amount, timelock, initiator, fee],
      })
      .catch((e: unknown) => {
        // A retired factory with another computeAddress signature reverts; anything else (a timeout, a
        // 429) is an RPC failure, and must not be reported as a foreign escrow.
        if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return null;
        throw e;
      });
    if (at && at.toLowerCase() === clone.toLowerCase()) {
      ours = true;
      break;
    }
  }
  if (!ours) throw new Error(`${clone} is not an escrow of a Hashlock factory this release knows on chain ${chain.chainId}`);
  const held =
    token === ZERO
      ? await pub.getBalance({ address: clone })
      : await pub.readContract({ address: token, abi: balanceOfAbi, functionName: 'balanceOf', args: [clone] });
  return {
    hashlock: hashlock.slice(2).toLowerCase(),
    recipient: recipient.toLowerCase(),
    token: token === ZERO ? null : token.toLowerCase(),
    amount: held < amount ? held : amount,
    timelock: Number(timelock),
    open: !claimed && !refunded,
  };
}

/**
 * Whether the clone `fund` would create already exists: the factory derives its address from these very
 * terms, so code there means this leg was funded already (a retry must not pay it again).
 */
export async function cloneExists(
  chain: Pick<EvmChain, 'rpcUrl' | 'factory'>,
  p: { swapId: string; hashlockHex: string; recipient: Address; token: Address | null; amount: bigint; timelockUnix: number; initiator: Address; fee: bigint },
): Promise<boolean> {
  const pub = createPublicClient({ transport: http(chain.rpcUrl) });
  const at = await pub.readContract({
    address: chain.factory,
    abi: computeAddressAbi,
    functionName: 'computeAddress',
    args: [keccak256(toHex(p.swapId)), `0x${p.hashlockHex}`, p.recipient, p.token ?? ZERO, p.amount, BigInt(p.timelockUnix), p.initiator, p.fee],
  });
  const code = await pub.getCode({ address: at });
  return !!code && code !== '0x';
}

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

  /** Take the funded clone back after its timelock. The clone refuses before it, so the chain is the gate. */
  async refund(chain: EvmChain, clone: Address): Promise<string> {
    const { wallet, pub } = this.clients(chain);
    const data = encodeFunctionData({ abi: htlcAbi, functionName: 'refund', args: [] });
    const hash = await wallet.sendTransaction({ to: clone, data });
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
