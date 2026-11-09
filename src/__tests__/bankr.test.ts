import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseTransaction, recoverTransactionAddress, toFunctionSelector, verifyMessage, type TransactionSerializable } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bankrAccount, differsFrom } from '../chains/bankr.js';
import { EvmSigner } from '../chains/evm.js';
import { loadConfig } from '../config.js';

/**
 * The Bankr wallet end to end, with both outside parties played here: Bankr's Wallet API (a key that
 * signs what it is asked — or, when a test says so, something else) and the chain's node (which records
 * what is broadcast). What is under test is the real path: EvmSigner → viem → the Bankr account → the node.
 */
const bankrKey = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const CLONE = `0x${'44'.repeat(20)}` as const;
const CHAIN_ID = 8453;

/** What the fake Bankr does with the transaction it was asked to sign; identity = an honest signer. */
let tamper: (tx: TransactionSerializable) => TransactionSerializable = (tx) => tx;
let signAs = bankrKey;
let refuse: { status: number; body: unknown } | null = null;
let bareSignature = false;
let noSignature = false;
let solanaOnly = false;
/** A chain without EIP-1559: the node's blocks carry no base fee, so the transaction is built legacy. */
let legacyNode = false;
const asked: unknown[] = [];

const broadcast: `0x${string}`[] = [];
let node: Server;
let rpcUrl: string;

beforeAll(async () => {
  node = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const answer = (q: { id: number; method: string; params: unknown[] }) => {
        const result = (() => {
          switch (q.method) {
            case 'eth_chainId':
              return `0x${CHAIN_ID.toString(16)}`;
            case 'eth_getTransactionCount':
              return '0x7';
            case 'eth_estimateGas':
              return '0xc350';
            case 'eth_maxPriorityFeePerGas':
              return '0x3b9aca00';
            case 'eth_gasPrice':
              return '0x77359400';
            case 'eth_blockNumber':
              return '0x10';
            case 'eth_getBlockByNumber':
              return { number: '0x10', hash: `0x${'01'.repeat(32)}`, ...(legacyNode ? {} : { baseFeePerGas: '0x3b9aca00' }), timestamp: '0x1', transactions: [] };
            case 'eth_sendRawTransaction':
              broadcast.push(q.params[0] as `0x${string}`);
              return `0x${'ee'.repeat(32)}`;
            case 'eth_getTransactionReceipt':
              return { transactionHash: q.params[0], blockNumber: '0x10', blockHash: `0x${'01'.repeat(32)}`, status: '0x1', logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', transactionIndex: '0x0', from: bankrKey.address, to: CLONE, contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, type: '0x2' };
            default:
              return null;
          }
        })();
        return { jsonrpc: '2.0', id: q.id, result };
      };
      const body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
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
    if (u.endsWith('/wallet/me')) return json(200, { success: true, wallets: [{ chain: 'solana', address: 'So1' }, ...(solanaOnly ? [] : [{ chain: 'evm', address: bankrKey.address }])] });
    if (refuse) return json(refuse.status, refuse.body);
    const q = JSON.parse(String(init?.body));
    asked.push(q);
    if (q.signatureType === 'personal_sign') return json(200, { success: true, signer: signAs.address, signature: await signAs.signMessage({ message: q.message }) });
    const t = q.transaction;
    const call = { to: t.to, chainId: t.chainId, value: BigInt(t.value), data: t.data, gas: BigInt(t.gas), nonce: t.nonce };
    const tx = tamper(
      t.gasPrice !== undefined
        ? { type: 'legacy', ...call, gasPrice: BigInt(t.gasPrice) }
        : { type: 'eip1559', ...call, maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) },
    );
    if (noSignature) return json(200, { success: true, signer: signAs.address });
    const signature = bareSignature ? await signAs.signMessage({ message: 'not a transaction' }) : await signAs.signTransaction(tx);
    return json(200, { success: true, signer: signAs.address, signature, signatureType: 'eth_signTransaction' });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  node.close();
});
afterEach(() => {
  tamper = (tx) => tx;
  signAs = bankrKey;
  refuse = null;
  bareSignature = false;
  noSignature = false;
  solanaOnly = false;
  legacyNode = false;
  asked.length = 0;
  broadcast.length = 0;
});

const chain = () => ({ rpcUrl, chainId: CHAIN_ID, factory: `0x${'0f'.repeat(20)}` as const });
const signer = async () => new EvmSigner(await bankrAccount('bk_test'));

describe('a Bankr wallet as the EVM signer', () => {
  it('is the EVM wallet Bankr names, and signs the login message as it', async () => {
    const s = await signer();
    expect(s.address).toBe(bankrKey.address);
    const message = 'Hashlock Markets wants you to sign in.\n\nAddress: x\nNonce: n';
    expect(await verifyMessage({ address: s.address, message, signature: (await s.signLoginMessage(message)) as `0x${string}` })).toBe(true);
  });

  it('settles through the same path as a local key: the node receives the call this server built, signed by the Bankr wallet', async () => {
    const hash = await (await signer()).refund(chain(), CLONE);
    expect(hash).toBe(`0x${'ee'.repeat(32)}`);
    expect(broadcast).toHaveLength(1);
    const sent = parseTransaction(broadcast[0]);
    expect(await recoverTransactionAddress({ serializedTransaction: broadcast[0] as never })).toBe(bankrKey.address);
    expect(sent).toMatchObject({ to: CLONE, data: toFunctionSelector('refund()'), chainId: CHAIN_ID, nonce: 7 });
    expect(sent.value ?? 0n).toBe(0n);
    // Bankr was asked for exactly that call, numbered and priced against this server's own node.
    expect(asked).toEqual([
      { signatureType: 'eth_signTransaction', transaction: expect.objectContaining({ to: CLONE, chainId: CHAIN_ID, value: '0', data: toFunctionSelector('refund()'), nonce: 7, gas: '50000' }) },
    ]);
  });

  it('does the same on a chain without EIP-1559: a legacy transaction, asked for and signed as one', async () => {
    legacyNode = true;
    await (await signer()).refund(chain(), CLONE);
    expect(parseTransaction(broadcast[0])).toMatchObject({ type: 'legacy', to: CLONE, chainId: CHAIN_ID, nonce: 7, gasPrice: 2400000000n }); // the node's 2 gwei, with viem's 20% headroom
    expect(asked).toEqual([{ signatureType: 'eth_signTransaction', transaction: expect.objectContaining({ gasPrice: '2400000000' }) }]);
    expect((asked[0] as { transaction: object }).transaction).not.toHaveProperty('maxFeePerGas');
  });

  // Exactly the transaction built here, or nothing: every row is a transaction this server did not build.
  const other = `0x${'66'.repeat(20)}` as const;
  it.each<[string, (tx: TransactionSerializable) => TransactionSerializable, RegExp]>([
    ['another destination', (tx) => ({ ...tx, to: other }), /different transaction.*\(to 0x66/],
    ['other calldata', (tx) => ({ ...tx, data: '0xa9059cbb' }), /different transaction.*\(data 0xa9059cbb/],
    ['value added to the call', (tx) => ({ ...tx, value: 10n ** 18n }), /different transaction.*\(value 1000000000000000000/],
    ['another nonce', (tx) => ({ ...tx, nonce: 8 }), /different transaction.*\(nonce 8/],
    ['another chain', (tx) => ({ ...tx, chainId: 1 }), /different transaction.*\(chainId 1/],
    ['a higher fee', (tx) => ({ ...tx, maxFeePerGas: tx.maxFeePerGas! * 100n }), /different transaction.*\(maxFeePerGas/],
    ['a lower fee, which may never mine', (tx) => ({ ...tx, maxFeePerGas: tx.maxFeePerGas! / 2n, maxPriorityFeePerGas: 1n }), /different transaction.*\(maxFeePerGas/],
    ['the whole fee cap as the tip', (tx) => ({ ...tx, maxPriorityFeePerGas: tx.maxFeePerGas }), /different transaction.*\(maxPriorityFeePerGas/],
    ['more gas', (tx) => ({ ...tx, gas: tx.gas! * 100n }), /different transaction.*\(gas 5000000/],
    ['less gas, which reverts', (tx) => ({ ...tx, gas: 21000n }), /different transaction.*\(gas 21000/],
    ['a legacy transaction at the fee cap', (tx) => ({ type: 'legacy', to: tx.to, chainId: tx.chainId, value: tx.value, data: tx.data, gas: tx.gas, nonce: tx.nonce, gasPrice: tx.maxFeePerGas }), /different transaction.*\(type legacy/],
    ['an access list', (tx) => ({ ...tx, accessList: [{ address: other, storageKeys: [] }] }), /different transaction.*\(its encoding/],
    ['a delegation of the wallet (EIP-7702)', (tx) => ({ ...tx, type: 'eip7702', authorizationList: [{ address: other, chainId: CHAIN_ID, nonce: 0, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, yParity: 0 }] }) as TransactionSerializable, /different transaction.*\(type eip7702/],
  ])('broadcasts nothing when Bankr signs %s', async (_name, change, error) => {
    tamper = change;
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(error);
    expect(broadcast).toHaveLength(0);
  });

  it('names a signed transaction no node would take, rather than throwing on it', () => {
    const built: TransactionSerializable = { type: 'eip1559', to: CLONE, chainId: CHAIN_ID, nonce: 7, gas: 50000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
    expect(differsFrom(built, built)).toBeNull();
    expect(differsFrom(built, { ...built, maxPriorityFeePerGas: 20n })).toMatch(/not a valid transaction/); // a tip above the fee cap
  });

  it('broadcasts nothing when another key signed the right call', async () => {
    signAs = stranger;
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(new RegExp(`signed as ${stranger.address}, not as this wallet`));
    expect(broadcast).toHaveLength(0);
  });

  it('broadcasts nothing when the answer is not a signed transaction', async () => {
    bareSignature = true;
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(/did not answer with a signed transaction/);
    expect(broadcast).toHaveLength(0);
  });

  it('says so when Bankr answers without a signature, for a transaction or a login', async () => {
    noSignature = true;
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(/answered without a signature/);
    refuse = { status: 200, body: { success: true } };
    await expect((await signer()).signLoginMessage('hi')).rejects.toThrow(/answered without a signature/);
    expect(broadcast).toHaveLength(0);
  });

  it("passes Bankr's refusal on in its own words, which name the setting to change", async () => {
    refuse = { status: 403, body: { error: 'Arbitrary contract calls disabled', message: 'Re-enable in Security settings if you want to proceed.' } };
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(/Bankr \/wallet\/sign: Arbitrary contract calls disabled — Re-enable in Security settings/);
    refuse = { status: 200, body: { success: false, error: 'signer rejected' } };
    await expect((await signer()).signLoginMessage('hi')).rejects.toThrow(/Bankr \/wallet\/sign: signer rejected/);
    // A validation error is an object — e.g. a chain Bankr does not sign for (a testnet).
    refuse = { status: 400, body: { error: { type: 'validation', message: 'chainId must be one of 1, 8453, …' } } };
    await expect((await signer()).refund(chain(), CLONE)).rejects.toThrow(/Bankr \/wallet\/sign: .*chainId must be one of/);
    expect(broadcast).toHaveLength(0);
  });

  it('says so when the key is not a Bankr key, or its wallet has no EVM address', async () => {
    await expect(bankrAccount('wrong')).rejects.toThrow(/Bankr \/wallet\/me: Invalid API key/);
    solanaOnly = true;
    await expect(bankrAccount('bk_test')).rejects.toThrow(/this key has no EVM wallet/);
  });
});

describe('config', () => {
  const base = { HASHLOCK_API_URL: 'https://example.test/api' };
  it('takes a Bankr wallet in place of an EVM key, never beside one', () => {
    expect(loadConfig({ ...base, HASHLOCK_BANKR_API_KEY: ' bk_x ' })).toMatchObject({ bankrApiKey: 'bk_x', evmKey: undefined });
    expect(() => loadConfig({ ...base, HASHLOCK_BANKR_API_KEY: 'bk_x', HASHLOCK_EVM_KEY: `0x${'11'.repeat(32)}` })).toThrow(/not both/);
  });
});
