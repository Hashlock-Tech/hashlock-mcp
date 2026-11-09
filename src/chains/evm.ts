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
  type Hex,
} from 'viem';
import type { LocalAccount } from 'viem/accounts';
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

export interface EvmCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * A wallet that signs and broadcasts its own transactions (its key is not in this process), as a browser
 * wallet does for a web app. chains/bankr.ts is one. `send` answers with the hash of the transaction it broadcast.
 */
export interface SendingWallet {
  address: Address;
  signMessage(message: string): Promise<Hex>;
  send(chainId: number, call: Required<EvmCall> & { gas: bigint }): Promise<Hex>;
}

export class EvmSigner {
  /**
   * The wallet: a local key, which signs here and is broadcast through the chain's RPC, or one that sends
   * its own transactions. What is sent, and how its outcome is read, is the same for both.
   */
  constructor(private readonly wallet: LocalAccount | SendingWallet) {}
  get address(): Address {
    return this.wallet.address;
  }
  signLoginMessage(message: string): Promise<string> {
    return 'send' in this.wallet ? this.wallet.signMessage(message) : this.wallet.signMessage({ message });
  }

  /**
   * One call: checked against this server's own RPC first, handed over, and followed on this server's RPC
   * until it is mined. A local key is signed here and broadcast through the RPC (viem estimates the gas,
   * so a call that would revert stops before anything is sent). A wallet that sends itself is given the
   * call with this server's gas estimate, which stops a reverting call the same way.
   * `whenReverted` is appended to the error for a transaction that was mined and reverted.
   */
  private async send(chain: EvmChain, call: EvmCall, whenReverted = ''): Promise<Hex> {
    const def = { id: chain.chainId, name: `evm-${chain.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } } as const;
    const pub = createPublicClient({ chain: def, transport: http(chain.rpcUrl) });
    const value = call.value ?? 0n;

    let sent: Hex;
    if ('send' in this.wallet) {
      // viem checks this for a local key; here the chain id goes to the wallet, so it is checked here.
      const onChain = await pub.getChainId();
      if (onChain !== chain.chainId) throw new Error(`the endpoint configured for chain ${chain.chainId} answers as chain ${onChain} — check its URL`);
      const gas = await pub.estimateGas({ account: this.wallet.address, to: call.to, data: call.data, value });
      sent = await this.wallet.send(chain.chainId, { to: call.to, data: call.data, value, gas });
    } else {
      sent = await createWalletClient({ account: this.wallet, chain: def, transport: http(chain.rpcUrl) }).sendTransaction({ to: call.to, data: call.data, value });
    }
    const receipt = await pub.waitForTransactionReceipt({ hash: sent }).catch((e: unknown) => {
      // It WAS sent: repeating the step now would send it a second time.
      throw new Error(`transaction ${sent} was sent, but its outcome could not be read here (${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}) — check the swap before retrying`);
    });
    const hash = receipt.transactionHash; // the one that was mined, should the wallet have re-priced it
    // A hash alone does not say the call went through: a transaction that was mined and reverted moved nothing.
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} was mined and reverted — it moved nothing; check the swap before retrying.${whenReverted}`);
    return hash;
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
    const salt = keccak256(toHex(p.swapId));
    const token = p.token ?? ZERO;
    if (p.token) {
      await this.send(chain, { to: p.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [chain.factory, p.amount + p.fee] }) });
    }
    const data = encodeFunctionData({
      abi: factoryAbi,
      functionName: 'createSwap',
      args: [salt, `0x${p.hashlockHex}`, p.recipient, token, p.amount, BigInt(p.timelockUnix), p.refund, p.fee],
    });
    return this.send(chain, { to: chain.factory, data, value: p.token ? 0n : p.amount + p.fee });
  }

  /** Take the funded clone back after its timelock. The clone refuses before it, so the chain is the gate. */
  async refund(chain: EvmChain, clone: Address): Promise<string> {
    return this.send(chain, { to: clone, data: encodeFunctionData({ abi: htlcAbi, functionName: 'refund', args: [] }) });
  }

  /** Claim a funded clone with the preimage (reveals the secret on-chain). */
  async claim(chain: EvmChain, clone: Address, secretHex: string): Promise<string> {
    const data = encodeFunctionData({ abi: htlcAbi, functionName: 'claim', args: [`0x${secretHex.replace(/^0x/, '')}`] });
    return this.send(chain, { to: clone, data }, ' The secret is in that transaction\'s calldata, so it is public: if the leg is still open, claim it again at once.');
  }
}
