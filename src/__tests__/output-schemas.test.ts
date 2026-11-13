import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { Asset, Rfq, Swap, Thread } from '../client.js';
import { registerHostedTools } from '../http/tools.js';
import type { CallV1 } from '../http/v1-client.js';
import { registerTools } from '../tools.js';

// An output schema the result does not match fails the call — on the server (validateToolOutput) and again on the
// client, against the JSON Schema it listed. So every call goes through a real Client after listTools, and must
// come back without an error and with structuredContent. Payloads carry fields the schemas do not declare, as the
// live API does.
async function connect(register: (s: McpServer) => void) {
  const server = new McpServer({ name: 't', version: '0' });
  register(server);
  const client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools(); // caches the client-side validators
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text, name).not.toMatch(/validation error/i);
    return r as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  };
}

const ID = '11111111-1111-4111-8111-111111111111';
const USDT: Asset = { id: 'a-usdt', symbol: 'USDT', name: 'Tether', chain: 'ethereum', decimals: 6, address: '0x' + '1'.repeat(40), enabled: true };
const BTC: Asset = { id: 'a-btc', symbol: 'BTC', name: 'Bitcoin', chain: 'bitcoin', decimals: 8, address: null, isNative: true, enabled: true };
const rfq: Rfq = {
  id: ID, creatorId: 'u1', direction: 'sell_base', baseAssetId: BTC.id, baseAmount: '5000000', quoteAssetId: USDT.id,
  askAmount: null, visibility: 'public', targetAddress: null, status: 'open', expiresAt: '2026-11-03T00:00:00Z', createdAt: '2026-11-02T00:00:00Z',
};
const thread: Thread = {
  id: ID, rfqId: ID, makerId: 'u2', takerId: 'u1', status: 'agreed', currentQuoteAmount: '3500000000', pendingAmount: null,
  pendingBy: null, takerAccepted: true, makerAccepted: true, hashlock: 'ab'.repeat(32),
};
const swap = {
  id: ID, threadId: ID, makerId: 'u2', takerId: 'u1', initiatorUserId: 'u1', status: 'a_funded', hashlock: 'ab'.repeat(32),
  secretCiphertext: null, onchainSwapId: null, feePayerId: 'u1', feeAssetId: USDT.id, feeAmount: '0',
  aAssetId: BTC.id, aChain: 'bitcoin', aAmount: '5000000', aTimelock: '2026-11-03T00:00:00Z', aPayoutAddress: null, aRefundAddress: '02' + 'cd'.repeat(32),
  aHtlcAddress: 'bc1q' + 'x'.repeat(58), aRedeemScript: 'aa', aFundTx: 'ef'.repeat(32), aClaimTx: null, aFundOutpoints: [{ txid: 'ef'.repeat(32), vout: 0 }],
  bAssetId: USDT.id, bChain: 'ethereum', bAmount: '3500000000', bTimelock: '2026-11-02T04:00:00Z', bPayoutAddress: null, bRefundAddress: null,
  bHtlcAddress: null, bRedeemScript: null, bFundTx: null, bClaimTx: null, createdAt: '2026-11-02T00:00:00Z',
} satisfies Swap;

describe('stdio tools: every result validates against its output schema', async () => {
  const api = {
    myId: 'u1',
    assets: async () => [USDT, BTC],
    familyOf: async (chain: string) => (chain === 'bitcoin' ? 'btc' : 'evm'),
    listRfqs: async () => ({ rfqs: [rfq, { ...rfq, id: 'r2', status: 'expired' }] }),
    getRfq: async (id: string) => {
      if (id !== ID) throw new Error('request not found');
      return { rfq };
    },
    myRfqs: async () => ({ rfqs: [rfq, { ...rfq, visibility: 'private', askAmount: '3500000000' }] }),
    myThreads: async () => ({ threads: [thread, { ...thread, status: 'open', pendingAmount: '3400000000', pendingBy: 'u2', makerAccepted: false }] }),
    getThread: async () => ({ thread, rfq, messages: [{ id: 'm', threadId: ID, senderId: 'u2', kind: 'chat', body: 'hi', amount: null, createdAt: '2026-11-02T00:00:00Z' }], swap }),
    postMessage: async () => ({}),
    reject: async () => ({}),
    setProfile: async (p: { handle?: string | null; handlePublic?: boolean }) => ({ handle: p.handle ?? null, handlePublic: p.handlePublic ?? false }),
  };
  const secrets = { get: () => null };
  const call = await connect((s) => registerTools(s, api as never, secrets as never, {} as never));

  it('list tools return the JSON array as text and { items } as structuredContent', async () => {
    for (const name of ['list_assets', 'list_open_rfqs', 'my_rfqs', 'my_deals']) {
      const r = await call(name);
      expect(r.structuredContent, name).toEqual({ items: JSON.parse(r.content[0]!.text) });
      expect((r.structuredContent!.items as unknown[]).length, name).toBeGreaterThan(0);
    }
  });

  it('object tools return the shown object as structuredContent', async () => {
    for (const [name, args] of [
      ['get_rfq', { rfq_id: ID }],
      ['deal_status', { thread_id: ID }],
      ['negotiate', { thread_id: ID, action: 'message', body: 'hello' }],
      ['negotiate', { thread_id: ID, action: 'reject' }],
      ['set_profile', { handle: 'my_desk', handle_public: true }],
      ['set_profile', { handle: null }],
    ] as const) {
      const r = await call(name, args);
      expect(r.structuredContent, name).toEqual(JSON.parse(r.content[0]!.text));
      expect(r.structuredContent!.error, name).toBeUndefined();
    }
  });

  it('set_profile hands its snake_case argument to the API as handlePublic', async () => {
    expect((await call('set_profile', { handle: 'my_desk', handle_public: true })).structuredContent).toEqual({ handle: 'my_desk', handlePublic: true });
    expect((await call('set_profile', { handle_public: false })).structuredContent).toEqual({ handle: null, handlePublic: false });
  });

  it('a tool that throws returns the error envelope, and it validates too', async () => {
    const r = await call('get_rfq', { rfq_id: '22222222-2222-4222-8222-222222222222' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0]!.text));
    expect((r.structuredContent!.error as { code: string }).code).toBe('NOT_FOUND');
  });
});

// What /v1 build_fund/claim/refund answer, field for field (hashlock-markets packages/api/src/routes/settlement-legs.ts
// and the builders it spreads: chains/evm/build.ts, chains/tron/build.ts buildTronTrigger, chains/solana/tx.ts
// unsignedSolanaTx, btcFundAnswer, chains/bitcoin/spend.ts prepareBtcSpend — whose amountSats is a NUMBER).
const LEG = { evm: '33333333-3333-4333-8333-333333333333', tron: '44444444-4444-4444-8444-444444444444', solana: '55555555-5555-4555-8555-555555555555', bitcoin: '66666666-6666-4666-8666-666666666666' };
const evmTx = (value = '0x0') => ({ to: '0x' + '2'.repeat(40), data: '0x095ea7b3' + '0'.repeat(128), value });
const tronTx = () => ({ transaction: { visible: false, txID: 'aa'.repeat(32), raw_data: { contract: [], ref_block_bytes: '0000', expiration: 1, timestamp: 0 }, raw_data_hex: '0a02' }, txID: 'aa'.repeat(32) });
const solanaTx = { transactionBase64: 'AQAAAA==', blockhash: '9'.repeat(43), lastValidBlockHeight: 312345678 };
const btcSpend = { toAddress: 'bc1q' + 'y'.repeat(38), psbtBase64: 'cHNidP8BAA==', sighashHex: '11'.repeat(32), sighashHexes: ['11'.repeat(32), '22'.repeat(32)], amountSats: 4998500, feeSats: 1500 };
const BUILDS: Record<string, unknown> = {
  [`POST /swaps/${LEG.evm}/legs/a/fund`]: { chain: 'ethereum', family: 'evm', chainId: 1, sign: 'evm-tx', from: '0x' + '3'.repeat(40), txs: [evmTx(), evmTx()] },
  [`POST /swaps/${LEG.evm}/legs/b/claim`]: { chain: 'ethereum', family: 'evm', chainId: 1, sign: 'evm-tx', txs: [evmTx()] },
  [`POST /swaps/${LEG.evm}/legs/a/refund`]: { chain: 'ethereum', family: 'evm', chainId: 1, sign: 'evm-tx', txs: [evmTx()] },
  [`POST /swaps/${LEG.tron}/legs/a/fund`]: { chain: 'tron', family: 'tvm', sign: 'tron-txid', from: 'T' + 'A'.repeat(33), transactions: [tronTx(), tronTx()] },
  [`POST /swaps/${LEG.tron}/legs/b/claim`]: { chain: 'tron', family: 'tvm', sign: 'tron-txid', from: 'T' + 'A'.repeat(33), transactions: [tronTx()] },
  [`POST /swaps/${LEG.tron}/legs/a/refund`]: { chain: 'tron', family: 'tvm', sign: 'tron-txid', from: 'T' + 'A'.repeat(33), transactions: [tronTx()] },
  [`POST /swaps/${LEG.solana}/legs/a/fund`]: { chain: 'solana', family: 'svm', sign: 'solana-tx', escrow: 'E'.repeat(44), ...solanaTx, note: 'Sign the base64 transaction with the funder key' },
  [`POST /swaps/${LEG.solana}/legs/b/claim`]: { chain: 'solana', family: 'svm', sign: 'solana-tx', escrow: 'E'.repeat(44), ...solanaTx, note: 'Sign with the recipient key' },
  [`POST /swaps/${LEG.solana}/legs/a/refund`]: { chain: 'solana', family: 'svm', sign: 'solana-tx', escrow: 'E'.repeat(44), timelockUnix: 1793750400, ...solanaTx, note: 'Only valid once the timelock has passed' },
  [`POST /swaps/${LEG.bitcoin}/legs/a/fund`]: { chain: 'bitcoin', family: 'bitcoin', sign: 'btc-payment', payTo: 'bc1q' + 'x'.repeat(58), amountSats: '5000000', feePayTo: 'bc1q' + 'f'.repeat(38), feeAmountSats: '1500', note: 'Pay amountSats to payTo AND feeAmountSats to feePayTo' },
  [`POST /swaps/${LEG.bitcoin}/legs/b/fund`]: { chain: 'bitcoin', family: 'bitcoin', sign: 'btc-payment', payTo: 'bc1q' + 'x'.repeat(58), amountSats: '20000', topUp: true, note: 'The escrow already holds 4980000 sats' },
  [`POST /swaps/${LEG.bitcoin}/legs/b/claim`]: { chain: 'bitcoin', family: 'bitcoin', sign: 'btc-sighash', ...btcSpend, preimageHex: 'ab'.repeat(32), note: 'Sign EACH entry of sighashHexes' },
  [`POST /swaps/${LEG.bitcoin}/legs/a/refund`]: { chain: 'bitcoin', family: 'bitcoin', sign: 'btc-sighash', ...btcSpend, timelockUnix: 1793750400, note: 'Only relayable once the MEDIAN TIME PAST has passed' },
};

describe('hosted tools: every result validates against its output schema', async () => {
  const v1Rfq = { ...rfq, client: 'api', quoteAmountHint: null };
  const v1Thread = { ...thread, counterpartyName: null, createdAt: '2026-11-02T00:00:00Z' };
  const routes: Record<string, unknown> = {
    'GET /me': { userId: 'u1', scopes: ['read', 'taker'], handle: null, handlePublic: false, wallets: { evm: { login: '0xabc', proven: [] }, bitcoin: { login: null, proven: [] } } },
    'GET /assets': { assets: [{ ...USDT, verified: true, createdAt: '2026-11-02T00:00:00Z' }] },
    'GET /rfqs': { rfqs: [v1Rfq], nextCursor: 'abc' },
    'GET /rfqs/mine': { rfqs: [v1Rfq], nextCursor: null },
    [`GET /rfqs/${ID}`]: { rfq: v1Rfq },
    [`GET /rfqs/${ID}/threads`]: { threads: [v1Thread] },
    'GET /swaps': { swaps: [swap], nextCursor: null },
    [`GET /swaps/${ID}`]: { swap },
    [`GET /threads/${ID}`]: { thread: v1Thread, rfq: v1Rfq, messages: [], swap: null },
    'GET /wallets/nonce': { nonce: 'n1' },
    'GET /wallets/nonce?purpose=authorize': { nonce: 'n2' },
    [`POST /rfqs/${ID}/quotes`]: { quote: { id: 'q' }, thread: { ...v1Thread, status: 'open', makerAccepted: true, takerAccepted: false } },
    [`POST /threads/${ID}/accept`]: { thread: v1Thread, swap },
    ...BUILDS,
    'POST /tx/broadcast': { txid: 'ef'.repeat(32) },
    'PATCH /me/profile': { handle: 'my_desk', handlePublic: true },
  };
  const callV1: CallV1 = async (path, init) => {
    const body = routes[`${init?.method ?? 'GET'} ${path}`];
    return body === undefined ? { status: 404, json: { error: `no route ${path}` } } : { status: 200, json: body };
  };
  const call = await connect((s) => registerHostedTools(s, callV1));

  it('passes the /v1 body through as structuredContent', async () => {
    for (const [name, args] of [
      ['whoami', {}],
      ['list_assets', {}],
      ['list_open_rfqs', {}],
      ['list_my_rfqs', {}],
      ['get_rfq', { id: ID }],
      ['list_rfq_threads', { id: ID }],
      ['list_swaps', {}],
      ['swap_status', { id: ID }],
      ['quote_rfq', { id: ID, quoteAmount: '3500000000' }],
      ['accept_terms', { id: ID, quoteAmount: '3500000000' }],
      ['broadcast_tx', { chain: 'evm', signed: '0x00' }],
      ['set_profile', { handle: 'my_desk', handlePublic: true }],
      ['set_profile', { handle: null }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(false);
      expect(r.structuredContent, name).toEqual(JSON.parse(r.content[0]!.text));
    }
  });

  it('every build shape validates — evm, tron, solana, bitcoin payment and sighash, for fund, claim and refund', async () => {
    const tools = { fund: 'build_fund', claim: 'build_claim', refund: 'build_refund' } as const;
    for (const route of Object.keys(BUILDS)) {
      const [, id, leg, action] = route.match(/^POST \/swaps\/([^/]+)\/legs\/([ab])\/(\w+)$/)!;
      const name = tools[action as keyof typeof tools];
      const r = await call(name, { id, leg, ...(action === 'claim' ? { secret: 'ab'.repeat(32) } : {}) });
      expect(r.isError, route).toBe(false);
      expect(r.structuredContent, route).toEqual(BUILDS[route]);
    }
  });

  it('get_thread keeps its notice in the text and carries it in structuredContent', async () => {
    const r = await call('get_thread', { id: ID });
    expect(r.content[0]!.text).toMatch(/^NOTICE: /);
    expect(r.structuredContent).toMatchObject({ notice: expect.stringMatching(/^NOTICE: /), ...(routes[`GET /threads/${ID}`] as object) });
  });

  it('wallet_proof_message returns the messages it built', async () => {
    const r = await call('wallet_proof_message', { address: 'a'.repeat(40), login: 'b'.repeat(40) });
    expect(r.structuredContent).toMatchObject({ nonce: 'n1', message: expect.stringContaining('Nonce: n1') });
    expect(r.structuredContent!.authorizationMessage).toContain('Nonce: n2');
  });

  it('a 4xx is isError and needs no structuredContent', async () => {
    const r = await call('swap_status', { id: '22222222-2222-4222-8222-222222222222' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
});
