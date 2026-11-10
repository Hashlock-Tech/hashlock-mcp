import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, getAddress, parseAbi, parseTransaction, toFunctionSelector, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bankrWallet } from '../chains/bankr.js';
import { EvmSigner } from '../chains/evm.js';
import { classifyError } from '../lib/errors.js';
import { loadConfig } from '../config.js';

/**
 * The Bankr wallet end to end, with both outside parties played here: Bankr's Wallet API (which signs the
 * login and "sends" what it is handed) and the chain's node (which estimates, and reports receipts).
 * What is under test is the real path: EvmSigner.send → this server's node, then the Bankr wallet.
 */
const bankrKey = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const localKey = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const CLONE = `0x${'44'.repeat(20)}` as const;
const FACTORY = `0x${'0f'.repeat(20)}` as const;
const TOKEN = `0x${'70'.repeat(20)}` as const;
const PAYEE = `0x${'99'.repeat(20)}` as const;
const CHAIN_ID = 8453;
const HASH = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** Bankr's answer to /wallet/submit and /wallet/sign when a test wants something other than success. */
let answer: { status: number; body: unknown } | null = null;
/** Answer /wallet/submit from this call number on (1-based), so an approve can pass and createSwap not. */
let answerFrom = 1;

let unreachable = false;
let solanaOnly = false;
const submitted: { transaction: Record<string, unknown>; waitForConfirmation?: boolean }[] = [];

/** The node: whether the call would revert, and how a mined transaction ended. */
/** The node refuses the gas estimate from this call number on (1-based); 0 = never. */
let revertFrom = 0;
let receiptStatus = '0x1';
/** What the token answers to allowance(owner, factory): an approval an earlier attempt left behind. */
let allowanceNow = 0n;
const estimated: unknown[] = [];
/** What each hash was, as the node saw it: who sent it, and to which contract. */
const mined = new Map<string, { from: string; to: string }>();

const broadcast: `0x${string}`[] = [];
let node: Server;
let rpcUrl: string;

beforeAll(async () => {
  node = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const one = (q: { id: number; method: string; params: unknown[] }) => {
        const ok = (result: unknown) => ({ jsonrpc: '2.0', id: q.id, result });
        switch (q.method) {
          case 'eth_chainId':
            return ok(`0x${CHAIN_ID.toString(16)}`);
          case 'eth_getTransactionCount':
            return ok('0x7');
          case 'eth_estimateGas':
            estimated.push(q.params[0]);
            return revertFrom && estimated.length >= revertFrom ? { jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted: NotInitiator' } } : ok('0xc350');
          case 'eth_call':
            return ok(`0x${allowanceNow.toString(16).padStart(64, '0')}`);
          case 'eth_maxPriorityFeePerGas':
            return ok('0x3b9aca00');
          case 'eth_blockNumber':
            return ok('0x10');
          case 'eth_getBlockByNumber':
            return ok({ number: '0x10', hash: HASH(1), baseFeePerGas: '0x3b9aca00', timestamp: '0x1', transactions: [] });
          case 'eth_sendRawTransaction': {
            broadcast.push(q.params[0] as `0x${string}`);
            const hash = HASH(0xee00 + broadcast.length);
            mined.set(hash, { from: localKey.address, to: parseTransaction(q.params[0] as `0x${string}`).to! });
            return ok(hash);
          }
          case 'eth_getTransactionReceipt':
            return ok({ transactionHash: q.params[0], blockNumber: '0x10', blockHash: HASH(1), status: receiptStatus, logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', transactionIndex: '0x0', ...(mined.get(q.params[0] as string) ?? { from: bankrKey.address, to: CLONE }), contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, type: '0x2' });
          default:
            return ok(null);
        }
      };
      const body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise<void>((r) => node.listen(0, '127.0.0.1', r));
  rpcUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;

  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith('https://api.bankr.bot')) return real(url, init);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if ((init?.headers as Record<string, string>)['X-API-Key'] !== 'bk_test') return json(401, { error: 'Invalid API key' });
    if (init?.redirect !== 'error') throw new Error('the Bankr key must not follow redirects');
    if (u.endsWith('/wallet/me')) return json(200, { success: true, wallets: [{ chain: 'solana', address: 'So1' }, ...(solanaOnly ? [] : [{ chain: 'evm', address: bankrKey.address }])] });
    if (unreachable) throw new TypeError('fetch failed');
    const q = JSON.parse(String(init?.body));
    if (u.endsWith('/wallet/submit')) {
      submitted.push(q);
      const said = answer && submitted.length >= answerFrom && typeof answer.body === 'object' ? (answer.body as { transactionHash?: string }).transactionHash : undefined;
      mined.set(said ?? HASH(submitted.length), { from: bankrKey.address, to: q.transaction.to });
    }
    if (answer && (!u.endsWith('/wallet/submit') || submitted.length >= answerFrom)) {
      return typeof answer.body === 'string' ? new Response(answer.body, { status: answer.status }) : json(answer.status, answer.body);
    }
    if (u.endsWith('/wallet/sign')) return json(200, { success: true, signer: bankrKey.address, signature: await bankrKey.signMessage({ message: q.message }) });
    return json(200, { success: true, transactionHash: HASH(submitted.length), status: 'pending', signer: bankrKey.address, chainId: q.transaction.chainId });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  node.close();
});
afterEach(() => {
  answer = null;
  answerFrom = 1;
  mined.clear();
  unreachable = false;
  solanaOnly = false;
  revertFrom = 0;
  receiptStatus = '0x1';
  allowanceNow = 0n;
  submitted.length = 0;
  estimated.length = 0;
  broadcast.length = 0;
});

const chain = () => ({ rpcUrl, chainId: CHAIN_ID, factory: FACTORY });
const signer = async () => new EvmSigner(await bankrWallet('bk_test'));
const terms = (token: `0x${string}` | null) => ({ swapId: '11111111-1111-4111-8111-111111111111', hashlockHex: 'ab'.repeat(32), recipient: PAYEE, refund: bankrKey.address, token, amount: 5_000_000n, timelockUnix: 1_800_000_000, fee: 15_000n });
const abi = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function createSwap(bytes32 salt, bytes32 hashlock, address recipient, address token, uint256 amount, uint256 timelock, address initiator, uint256 fee)',
]);
const decode = (data: unknown) => decodeFunctionData({ abi, data: data as `0x${string}` });

describe('a Bankr wallet as the EVM wallet', () => {
  it('is the EVM wallet Bankr names, and signs the login message as it', async () => {
    const s = await signer();
    expect(s.address).toBe(bankrKey.address);
    const message = 'Hashlock Markets wants you to sign in.\n\nAddress: x\nNonce: n';
    expect(await verifyMessage({ address: s.address, message, signature: (await s.signLoginMessage(message)) as `0x${string}` })).toBe(true);
  });

  it('hands Bankr the exact call this server built, after its own node said it would go through, and follows it on that node', async () => {
    const hash = await (await signer()).refund(chain(), CLONE);
    expect(hash).toBe(HASH(1));
    expect(estimated).toEqual([expect.objectContaining({ from: bankrKey.address, to: CLONE, data: toFunctionSelector('refund()') })]);
    expect(submitted).toEqual([
      { transaction: { to: CLONE, chainId: CHAIN_ID, data: toFunctionSelector('refund()'), value: '0', gas: '50000' }, description: 'Hashlock HTLC settlement', waitForConfirmation: false },
    ]);
    expect(broadcast).toHaveLength(0); // Bankr sends; this server broadcasts nothing itself
  });

  it('funds an ERC-20 leg as an approve of the factory, then createSwap with the recorded terms and no value', async () => {
    await (await signer()).fund(chain(), terms(TOKEN));
    expect(submitted.map((s) => [s.transaction.to, s.transaction.value])).toEqual([[TOKEN, '0'], [FACTORY, '0']]);
    expect(decode(submitted[0].transaction.data)).toMatchObject({ functionName: 'approve', args: [getAddress(FACTORY), 5_015_000n] });
    const create = decode(submitted[1].transaction.data);
    expect(create.functionName).toBe('createSwap');
    expect(create.args?.slice(1)).toEqual([`0x${'ab'.repeat(32)}`, getAddress(PAYEE), getAddress(TOKEN), 5_000_000n, 1_800_000_000n, bankrKey.address, 15_000n]);
  });

  it('reuses an approval a failed attempt left when it covers the total — a retry sends createSwap alone', async () => {
    allowanceNow = 5_015_000n;
    await (await signer()).fund(chain(), terms(TOKEN));
    expect(submitted.map((s) => decode(s.transaction.data).functionName)).toEqual(['createSwap']);
  });

  it('zeroes an approval that falls short before approving the total, as USDT refuses non-zero over non-zero', async () => {
    allowanceNow = 1n;
    await (await signer()).fund(chain(), terms(TOKEN));
    expect(submitted.map((s) => decode(s.transaction.data))).toMatchObject([
      { functionName: 'approve', args: [getAddress(FACTORY), 0n] },
      { functionName: 'approve', args: [getAddress(FACTORY), 5_015_000n] },
      { functionName: 'createSwap' },
    ]);
  });

  it('funds a native leg as one createSwap carrying the amount and the fee', async () => {
    await (await signer()).fund(chain(), terms(null));
    expect(submitted.map((s) => [s.transaction.to, s.transaction.value])).toEqual([[FACTORY, '5015000']]);
  });

  it('asks Bankr for nothing when the call would revert on its own node', async () => {
    revertFrom = 1;
    await expect((await signer()).claim(chain(), CLONE, 'cd'.repeat(32))).rejects.toThrow(/NotInitiator/);
    expect(submitted).toHaveLength(0);
  });

  it('does not send createSwap after an approve that was mined and reverted', async () => {
    receiptStatus = '0x0';
    await expect((await signer()).fund(chain(), terms(TOKEN))).rejects.toThrow(/was mined and reverted — it moved nothing/);
    expect(submitted).toHaveLength(1); // the approve only
  });

  it("passes on, in Bankr's words, what Bankr rejects before it signs — and does not hint that anything was sent", async () => {
    const refusals: [number, unknown, RegExp][] = [
      [403, { error: 'MFA required', code: 'MFA_REQUIRED', message: 'Contract calls need MFA. Turn on MFA, then switch contract calls on in Security settings.' }, /^Bankr \/wallet\/submit: MFA required — Contract calls need MFA. Turn on MFA, then switch contract calls on in Security settings\.$/],
      [403, { success: false, error: 'This transaction is $2450.00, above your per-transaction limit of $1000.', errorCode: 'PER_TX_LIMIT_EXCEEDED' }, /per-transaction limit of \$1000\.$/],
      [401, { error: 'Invalid API key' }, /Invalid API key$/],
      [429, { error: 'Too many requests' }, /Too many requests$/],
      // A validation error is an object — e.g. a chain Bankr does not send on (a testnet).
      [400, { error: { type: 'VALIDATION_ERROR', message: 'chainId must be one of 1, 8453, …' } }, /chainId must be one of[^—]*$/],
      [400, { success: false, error: 'insufficient_funds_for_gas' }, /insufficient_funds_for_gas$/],
    ];
    for (const [status, body, text] of refusals) {
      answer = { status, body };
      const e = (await (await signer()).refund(chain(), CLONE).catch((x: unknown) => x)) as Error;
      expect(e.message).toMatch(text);
      expect(classifyError(e)).toMatchObject({ code: 'UNKNOWN', is_retryable: false }); // not "fix the argument", not "rate limited"
    }
  });

  it('says a transaction may have been sent whenever Bankr does not say it rejected it before signing', async () => {
    const s = await signer();
    const shapes: { status: number; body: unknown }[] = [
      { status: 400, body: { success: false, error: 'The transaction could not be submitted' } }, // "submission failed": signed, then what?
      { status: 200, body: { success: false, error: 'signer rejected' } },
      { status: 502, body: '<html>Bad Gateway</html>' },
      { status: 500, body: { error: 'Internal error' } },
      { status: 200, body: { success: true } },
    ];
    for (const a of shapes) {
      answer = a;
      await expect(s.refund(chain(), CLONE)).rejects.toThrow(/^Bankr \/wallet\/submit: .* — the transaction may or may not have been sent; check the swap before retrying$/);
    }
    answer = null;
    unreachable = true;
    await expect(s.refund(chain(), CLONE)).rejects.toThrow(/Bankr \/wallet\/submit: could not be reached \(fetch failed\) — the transaction may or may not have been sent/);
  });

  it('lets the chain decide a failure that Bankr reports with a transaction hash: it was broadcast', async () => {
    answer = { status: 400, body: { success: false, status: 'reverted', transactionHash: HASH(5), error: 'reverted' } };
    await expect((await signer()).refund(chain(), CLONE)).resolves.toBe(HASH(5)); // this server's node says it succeeded
    receiptStatus = '0x0';
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(/was mined and reverted/);
  });

  it('refuses a login signature Bankr did not give', async () => {
    answer = { status: 200, body: { success: false, error: 'signer rejected' } };
    await expect((await signer()).signLoginMessage('hi')).rejects.toThrow(/Bankr \/wallet\/sign: signer rejected/);
    answer = { status: 200, body: { success: true } };
    await expect((await signer()).signLoginMessage('hi')).rejects.toThrow(/answered without a signature/);
  });

  it('will not send on a chain its RPC does not answer for', async () => {
    await expect((await signer()).refund({ ...chain(), chainId: 1 }, CLONE)).rejects.toThrow(/the endpoint configured for chain 1 answers as chain 8453/);
    expect(submitted).toHaveLength(0);
  });

  it('says so when the key is not a Bankr key, or its wallet has no EVM address', async () => {
    await expect(bankrWallet('wrong')).rejects.toThrow(/Bankr \/wallet\/me: Invalid API key/);
    solanaOnly = true;
    await expect(bankrWallet('bk_test')).rejects.toThrow(/this key has no EVM wallet/);
  });
});

describe('a local key, through the same node', () => {
  it('signs here and broadcasts through the RPC — Bankr is not involved', async () => {
    await new EvmSigner(localKey).refund(chain(), CLONE);
    expect(parseTransaction(broadcast[0])).toMatchObject({ to: CLONE, data: toFunctionSelector('refund()'), chainId: CHAIN_ID, nonce: 7 });
    expect(submitted).toHaveLength(0);
  });

  it('reports a claim that was mined and reverted as a failure, and says the secret is now public', async () => {
    receiptStatus = '0x0';
    await expect(new EvmSigner(localKey).claim(chain(), CLONE, 'cd'.repeat(32))).rejects.toThrow(/was mined and reverted — it moved nothing.*secret is in that transaction's calldata.*claim it again at once/);
  });
});

describe('config', () => {
  const base = { HASHLOCK_API_URL: 'https://example.test/api' };
  it('takes a Bankr wallet in place of an EVM key, never beside one', () => {
    expect(loadConfig({ ...base, HASHLOCK_BANKR_API_KEY: ' bk_x ' })).toMatchObject({ bankrApiKey: 'bk_x', evmKey: undefined });
    expect(() => loadConfig({ ...base, HASHLOCK_BANKR_API_KEY: 'bk_x', HASHLOCK_EVM_KEY: `0x${'11'.repeat(32)}` })).toThrow(/not both/);
  });
});
