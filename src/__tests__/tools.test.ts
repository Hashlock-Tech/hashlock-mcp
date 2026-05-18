import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HashLock } from '@hashlock-tech/sdk';
import type { PrincipalAttestation } from '@hashlock-tech/sdk';

// We test that the MCP server's tool handlers correctly call SDK methods.
// Since the MCP server instantiates HashLock internally, we test the SDK
// integration layer that the tools rely on.

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    statusText: 'OK',
    json: () => Promise.resolve(data),
  });
}

function createSDK(fetchFn: ReturnType<typeof vi.fn>) {
  return new HashLock({
    endpoint: 'http://localhost:4000/graphql',
    accessToken: 'test-token',
    fetch: fetchFn as unknown as typeof fetch,
    retries: 0,
  });
}

describe('MCP Tool → SDK Integration', () => {
  // ─── create_htlc → fundHTLC ────────────────────────────

  describe('create_htlc (fundHTLC)', () => {
    it('should call fundHTLC with correct parameters', async () => {
      const fetchFn = mockFetch({ data: { fundHTLC: { tradeId: 't-1', txHash: '0xabc', status: 'PENDING' } } });
      const hl = createSDK(fetchFn);

      const result = await hl.fundHTLC({
        tradeId: 't-1',
        txHash: '0xabc',
        role: 'INITIATOR',
        timelock: 1700000000,
        hashlock: '0xdef',
        chainType: 'evm',
      });

      expect(result.tradeId).toBe('t-1');
      expect(result.txHash).toBe('0xabc');
      expect(result.status).toBe('PENDING');

      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.tradeId).toBe('t-1');
      expect(body.variables.role).toBe('INITIATOR');
      expect(body.variables.chainType).toBe('evm');
    });

    it('should handle missing optional fields', async () => {
      const fetchFn = mockFetch({ data: { fundHTLC: { tradeId: 't-1', txHash: '0xabc', status: 'PENDING' } } });
      const hl = createSDK(fetchFn);

      const result = await hl.fundHTLC({
        tradeId: 't-1',
        txHash: '0xabc',
        role: 'COUNTERPARTY',
      });

      expect(result.status).toBe('PENDING');
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.chainType).toBeUndefined();
    });
  });

  // ─── withdraw_htlc → claimHTLC ─────────────────────────

  describe('withdraw_htlc (claimHTLC)', () => {
    it('should claim HTLC with preimage', async () => {
      const fetchFn = mockFetch({ data: { claimHTLC: { tradeId: 't-1', status: 'WITHDRAWN' } } });
      const hl = createSDK(fetchFn);

      const result = await hl.claimHTLC({
        tradeId: 't-1',
        txHash: '0xdef',
        preimage: '0xsecret123',
        chainType: 'evm',
      });

      expect(result.status).toBe('WITHDRAWN');
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.preimage).toBe('0xsecret123');
    });
  });

  // ─── refund_htlc → refundHTLC ──────────────────────────

  describe('refund_htlc (refundHTLC)', () => {
    it('should refund HTLC after timelock', async () => {
      const fetchFn = mockFetch({ data: { refundHTLC: { tradeId: 't-1', status: 'REFUNDED' } } });
      const hl = createSDK(fetchFn);

      const result = await hl.refundHTLC({
        tradeId: 't-1',
        txHash: '0xrefund',
      });

      expect(result.status).toBe('REFUNDED');
    });

    it('should support chainType parameter', async () => {
      const fetchFn = mockFetch({ data: { refundHTLC: { tradeId: 't-1', status: 'REFUNDED' } } });
      const hl = createSDK(fetchFn);

      await hl.refundHTLC({ tradeId: 't-1', txHash: '0xrefund', chainType: 'bitcoin' });

      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.chainType).toBe('bitcoin');
    });
  });

  // ─── get_htlc → getHTLCs ───────────────────────────────────────────
  // get_htlc MUST use getHTLCs (queries `htlcs`, which the backend serves),
  // NOT getHTLCStatus (queries htlcStatus.initiatorHTLC — a field the flat
  // HTLCStatusResult type does not have; rejected at GraphQL validation for
  // EVERY input). This test pins the working query shape.

  describe('get_htlc (getHTLCs)', () => {
    it('returns the per-leg HTLC array for a known trade', async () => {
      const htlcs = [
        { id: 'h1', tradeId: 't-1', role: 'INITIATOR', status: 'ACTIVE', contractAddress: '0x1', hashlock: '0xh', timelock: 999, amount: '1.0', txHash: '0xa', chainType: 'evm', preimage: null },
        { id: 'h2', tradeId: 't-1', role: 'COUNTERPARTY', status: 'ACTIVE', contractAddress: '0x2', hashlock: '0xh', timelock: 888, amount: '3500', txHash: '0xb', chainType: 'evm', preimage: null },
      ];
      const fetchFn = mockFetch({ data: { htlcs } });
      const hl = createSDK(fetchFn);

      const result = await hl.getHTLCs('t-1');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('INITIATOR');
      expect(result[1].role).toBe('COUNTERPARTY');
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.query).toContain('htlcs(tradeId');
      expect(body.query).not.toContain('initiatorHTLC');
      expect(body.variables.tradeId).toBe('t-1');
    });

    it('returns an empty array for an unknown trade (clean not-found signal)', async () => {
      const fetchFn = mockFetch({ data: { htlcs: [] } });
      const hl = createSDK(fetchFn);

      const result = await hl.getHTLCs('unknown-trade-id');
      expect(result).toEqual([]);
    });
  });

  // ─── create_rfq → createRFQ ────────────────────────────

  describe('create_rfq (createRFQ)', () => {
    it('should create RFQ with all fields', async () => {
      const rfq = { id: 'rfq-1', baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', amount: '2.0', status: 'ACTIVE', isBlind: false, createdAt: '2026-01-01', userId: 'u1', expiresAt: null, quotesCount: 0 };
      const fetchFn = mockFetch({ data: { createRFQ: rfq } });
      const hl = createSDK(fetchFn);

      const result = await hl.createRFQ({
        baseToken: 'ETH',
        quoteToken: 'USDT',
        side: 'SELL',
        amount: '2.0',
        expiresIn: 300,
        isBlind: false,
      });

      expect(result.id).toBe('rfq-1');
      expect(result.status).toBe('ACTIVE');
      expect(result.baseToken).toBe('ETH');
    });

    it('should support blind RFQ mode', async () => {
      const rfq = { id: 'rfq-2', baseToken: 'BTC', quoteToken: 'USDC', side: 'BUY', amount: '0.5', status: 'ACTIVE', isBlind: true, createdAt: '2026-01-01', userId: 'u1', expiresAt: null, quotesCount: 0 };
      const fetchFn = mockFetch({ data: { createRFQ: rfq } });
      const hl = createSDK(fetchFn);

      const result = await hl.createRFQ({ baseToken: 'BTC', quoteToken: 'USDC', side: 'BUY', amount: '0.5', isBlind: true });
      expect(result.isBlind).toBe(true);
    });

    it('should support cross-chain SUI/sui ↔ ETH/sepolia RFQ via baseChain + quoteChain', async () => {
      const rfq = { id: 'rfq-cross', baseToken: 'SUI', quoteToken: 'ETH', side: 'SELL', amount: '10', status: 'ACTIVE', isBlind: false, createdAt: '2026-05-06', userId: 'u1', expiresAt: null, quotesCount: 0 };
      const fetchFn = mockFetch({ data: { createRFQ: rfq } });
      const hl = createSDK(fetchFn);

      await hl.createRFQ({
        baseToken: 'SUI',
        baseChain: 'sui',
        quoteToken: 'ETH',
        quoteChain: 'sepolia',
        side: 'SELL',
        amount: '10',
      });

      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.baseChain).toBe('sui');
      expect(body.variables.quoteChain).toBe('sepolia');
    });
  });

  // ─── create_rfq description (intent-mapping rules) ─────────
  // The description is the LLM-side intent compiler. These tests pin the
  // load-bearing keywords so a future copy-edit cannot silently strip the
  // rules that turn user free-text into structured params. Failure here
  // means the LLM may start defaulting differently — verify the rule
  // change is intentional before relaxing the assertion.

  describe('create_rfq description carries intent-mapping rules', () => {
    // Re-import the module under test so we can read the exported description
    // constant directly. The tool registration itself happens at import time
    // against the @modelcontextprotocol/sdk runtime; we only need the prose.
    let description: string;

    beforeEach(async () => {
      // The description is a module-private constant; re-read the source so
      // we don't have to refactor src/index.ts to export it. This keeps the
      // test loosely coupled — a future refactor to `export const ...` is
      // welcome and will not break this assertion.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const url = await import('node:url');
      // src/index.ts is a sibling of __tests__ — resolve by walking up one dir
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const indexPath = path.resolve(here, '..', 'index.ts');
      description = await fs.readFile(indexPath, 'utf8');
    });

    it('lists every supported chain-qualified pair, including SUI on both chains', () => {
      for (const pair of ['ETH/sepolia', 'ETH/ethereum', 'BTC/bitcoin-signet', 'BTC/bitcoin', 'USDC/sepolia', 'USDC/ethereum', 'USDT/ethereum', 'WBTC/ethereum', 'WETH/ethereum', 'SUI/sui', 'SUI/sui-testnet']) {
        expect(description).toContain(pair);
      }
    });

    it('flags cross-chain RFQs as first-class with the SUI ↔ Sepolia exemplar', () => {
      expect(description).toMatch(/SUI\/sui ?[↔<>-]+ ?ETH\/sepolia/);
    });

    it('teaches the LLM the SELL / BUY verb mapping in English + Turkish', () => {
      // English
      expect(description).toMatch(/sell.*→.*SELL/i);
      expect(description).toMatch(/buy.*→.*BUY/i);
      // Turkish
      expect(description).toMatch(/sat.*→.*SELL/i);
      expect(description).toMatch(/al.*→.*BUY/i);
    });

    it('declares per-token mainnet chain inference defaults', () => {
      expect(description).toMatch(/ETH\/USDC\/USDT\/WBTC\/WETH.*ethereum/);
      expect(description).toMatch(/BTC.*bitcoin/);
      expect(description).toMatch(/SUI.*sui/);
    });

    it('forbids silent testnet-ification of an unqualified leg', () => {
      expect(description).toMatch(/Do NOT silently testnet-ify/i);
    });

    it('forbids pre-converting amount to wei / satoshis', () => {
      expect(description).toMatch(/Do NOT pre-convert/i);
      expect(description).toContain('wei');
      expect(description).toContain('satoshi');
    });

    it('requires the LLM to RESTATE the deal and confirm before calling', () => {
      expect(description).toMatch(/RESTATE/);
      expect(description).toMatch(/Real funds/);
      expect(description).toMatch(/confirm/i);
    });

    it('declares the expiresIn default of 300s', () => {
      expect(description).toMatch(/Default 300/);
    });

    it('declares the isBlind trigger words including ghost / gizli', () => {
      expect(description).toContain('ghost');
      expect(description).toContain('blind');
      expect(description).toContain('anonymous');
      expect(description).toContain('gizli');
    });

    it('contains the verbatim cross-chain SUI/sui ↔ ETH/sepolia example shape', () => {
      // Pin the canonical example so refactors keep it visible to the LLM —
      // examples are the highest-leverage portion of the description.
      expect(description).toMatch(/baseChain:\s*"sui"/);
      expect(description).toMatch(/quoteChain:\s*"sepolia"/);
    });
  });

  // ─── respond_rfq → submitQuote ─────────────────────────

  describe('respond_rfq (submitQuote)', () => {
    it('should submit a price quote', async () => {
      const quote = { id: 'q-1', rfqId: 'rfq-1', marketMakerId: 'mm-1', price: '3450.00', amount: '2.0', status: 'PENDING', createdAt: '2026-01-01', expiresAt: null };
      const fetchFn = mockFetch({ data: { submitQuote: quote } });
      const hl = createSDK(fetchFn);

      const result = await hl.submitQuote({
        rfqId: 'rfq-1',
        price: '3450.00',
        amount: '2.0',
      });

      expect(result.price).toBe('3450.00');
      expect(result.rfqId).toBe('rfq-1');
      expect(result.status).toBe('PENDING');
    });

    it('should support expiresIn parameter', async () => {
      const quote = { id: 'q-2', rfqId: 'rfq-1', marketMakerId: 'mm-1', price: '68000', amount: '0.5', status: 'PENDING', createdAt: '2026-01-01', expiresAt: '2026-01-01T00:05:00Z' };
      const fetchFn = mockFetch({ data: { submitQuote: quote } });
      const hl = createSDK(fetchFn);

      await hl.submitQuote({ rfqId: 'rfq-1', price: '68000', amount: '0.5', expiresIn: 300 });

      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.expiresIn).toBe(300);
    });
  });

  // ─── Agent principal layer (EXPERIMENTAL) ──────────────

  describe('agent principal fields pass through MCP → SDK', () => {
    const att: PrincipalAttestation = {
      principalId: 'pr_acme_001',
      principalType: 'INSTITUTION',
      tier: 'INSTITUTIONAL',
      blindId: 'ag_5g7k92bq',
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      proof: '0xdeadbeef',
    };

    it('create_rfq accepts attestation + agentInstance + tier filters', async () => {
      const rfq = {
        id: 'rfq-agent',
        baseToken: 'ETH',
        quoteToken: 'USDT',
        side: 'SELL',
        amount: '5.0',
        status: 'ACTIVE',
        isBlind: true,
        createdAt: '2026-04-11',
        userId: 'u1',
        expiresAt: null,
        quotesCount: 0,
      };
      const fetchFn = mockFetch({ data: { createRFQ: rfq } });
      const hl = createSDK(fetchFn);

      const result = await hl.createRFQ({
        baseToken: 'ETH',
        quoteToken: 'USDT',
        side: 'SELL',
        amount: '5.0',
        isBlind: true,
        attestation: att,
        agentInstance: { instanceId: 'ag_5g7k92bq', strategy: 'mm-eth-usdt' },
        minCounterpartyTier: 'STANDARD',
        hideIdentity: true,
      });

      expect(result.id).toBe('rfq-agent');
      // GraphQL wire-through is pending — variables are a strict
      // subset of the GraphQL schema, so new fields are dropped at
      // the SDK-client layer and never reach the endpoint.
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.baseToken).toBe('ETH');
      expect(body.variables.isBlind).toBe(true);
    });

    it('respond_rfq accepts attestation + hideIdentity', async () => {
      const quote = {
        id: 'q-agent',
        rfqId: 'rfq-1',
        marketMakerId: 'mm-1',
        price: '3450',
        amount: '1.0',
        status: 'PENDING',
        createdAt: '2026-04-11',
        expiresAt: null,
      };
      const fetchFn = mockFetch({ data: { submitQuote: quote } });
      const hl = createSDK(fetchFn);

      const result = await hl.submitQuote({
        rfqId: 'rfq-1',
        price: '3450',
        amount: '1.0',
        attestation: att,
        agentInstance: { instanceId: 'ag_5g7k92bq' },
        hideIdentity: true,
      });

      expect(result.id).toBe('q-agent');
    });

    it('create_htlc accepts attestation + agentInstance', async () => {
      const fetchFn = mockFetch({
        data: { fundHTLC: { tradeId: 't-1', txHash: '0xabc', status: 'PENDING' } },
      });
      const hl = createSDK(fetchFn);

      const result = await hl.fundHTLC({
        tradeId: 't-1',
        txHash: '0xabc',
        role: 'INITIATOR',
        chainType: 'evm',
        attestation: att,
        agentInstance: { instanceId: 'ag_5g7k92bq', strategy: 'mm-eth-usdt' },
      });

      expect(result.status).toBe('PENDING');
    });

    it('existing human calls still work without attestation (backward compat)', async () => {
      const rfq = {
        id: 'rfq-human',
        baseToken: 'ETH',
        quoteToken: 'USDT',
        side: 'BUY',
        amount: '1.0',
        status: 'ACTIVE',
        isBlind: false,
        createdAt: '2026-04-11',
        userId: 'u1',
        expiresAt: null,
        quotesCount: 0,
      };
      const fetchFn = mockFetch({ data: { createRFQ: rfq } });
      const hl = createSDK(fetchFn);

      const result = await hl.createRFQ({
        baseToken: 'ETH',
        quoteToken: 'USDT',
        side: 'BUY',
        amount: '1.0',
      });

      expect(result.id).toBe('rfq-human');
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.attestation).toBeUndefined();
    });
  });

  // ─── list_open_rfqs → listRFQs ────────────────────────

  describe('list_open_rfqs (listRFQs)', () => {
    it('requests ACTIVE rfqs with pagination', async () => {
      const fetchFn = mockFetch({ data: { rfqs: { rfqs: [{ id: 'r1', userId: 'u1', baseToken: 'ETH', quoteToken: 'USDC', side: 'SELL', amount: '2', isBlind: false, status: 'ACTIVE', expiresAt: null, createdAt: '2026-05-18', quotesCount: 0 }], total: 1, page: 1, pageSize: 20 } } });
      const hl = createSDK(fetchFn);
      const result = await hl.listRFQs({ status: 'ACTIVE', page: 1, pageSize: 20 });
      expect(result.rfqs).toHaveLength(1);
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.status).toBe('ACTIVE');
      expect(body.variables.pageSize).toBe(20);
    });
  });

  // ─── list_my_trades → listTrades ──────────────────────

  describe('list_my_trades (listTrades)', () => {
    it('passes an optional status filter through', async () => {
      const fetchFn = mockFetch({ data: { trades: { trades: [], total: 0 } } });
      const hl = createSDK(fetchFn);
      await hl.listTrades({ status: 'ACTIVE', page: 1, pageSize: 20 });
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.variables.status).toBe('ACTIVE');
    });
  });

  describe('homogenized tool descriptions carry routing markers', () => {
    // Pin the load-bearing routing markers so a future copy-edit cannot silently
    // strip the USE WHEN / DO NOT USE WHEN lines that LLM tool-routers depend on.
    // Each it() asserts text that is UNIQUE to that tool's description — not just
    // present anywhere in the file — so a per-tool regression is caught individually.
    let source: string;

    beforeEach(async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const url = await import('node:url');
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      source = await fs.readFile(path.resolve(here, '..', 'index.ts'), 'utf8');
    });

    it('create_htlc description: USE WHEN names the on-chain broadcast precondition', () => {
      expect(source).toMatch(/USE WHEN:.*broadcast.*lock transaction/);
    });

    it('create_htlc description: DO NOT USE WHEN names the not-yet-accepted guard', () => {
      expect(source).toMatch(/DO NOT USE WHEN:.*trade is not yet accepted/);
    });

    it('create_htlc description: PARAM NOTES declares role values INITIATOR and COUNTERPARTY', () => {
      expect(source).toMatch(/PARAM NOTES:.*INITIATOR.*COUNTERPARTY/);
    });

    it('withdraw_htlc description: DO NOT USE WHEN names refund_htlc as the alternative', () => {
      expect(source).toMatch(/DO NOT USE WHEN:.*timelock.*expired.*refund_htlc/);
    });

    it('withdraw_htlc description: PARAM NOTES explains the atomicity mechanism via preimage', () => {
      expect(source).toContain('simultaneously unlocks the counterparty leg');
    });

    it('refund_htlc description: DO NOT USE WHEN names withdraw_htlc as the alternative', () => {
      expect(source).toMatch(/DO NOT USE WHEN:.*HAS locked.*withdraw_htlc/);
    });

    it('refund_htlc description: PARAM NOTES states no preimage needed', () => {
      expect(source).toContain('No preimage needed');
    });

    it('respond_rfq description: USE WHEN names list_open_rfqs as the discovery step', () => {
      expect(source).toMatch(/USE WHEN:.*market maker.*list_open_rfqs/);
    });

    it('respond_rfq description: DO NOT USE WHEN names create_rfq as the buyer-side alternative', () => {
      expect(source).toMatch(/DO NOT USE WHEN:.*buyer.*seller.*create_rfq/);
    });

    it('respond_rfq description: PARAM NOTES explains price semantics', () => {
      expect(source).toContain('per unit of base token in quote-token terms');
    });

    it('does not weaken the create_rfq intent compiler', () => {
      expect(source).toContain('INTENT → PARAMS MAPPING');
      expect(source).toMatch(/RESTATE/);
      expect(source).toMatch(/Real funds/);
    });
  });

  describe('layer-2 swap facade descriptions + router boundary (pinned)', () => {
    let source: string;
    beforeEach(async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const url = await import('node:url');
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      source = await fs.readFile(path.resolve(here, '..', 'index.ts'), 'utf8');
    });

    it('registers all four swap tools', () => {
      for (const t of ['swap_quote', 'swap_status', 'swap_execute', 'swap_cancel']) {
        expect(source).toContain(`'${t}'`);
      }
    });
    it('swap_quote DO NOT USE WHEN routes maker-aware control to create_rfq', () => {
      expect(source).toMatch(/swap_quote[\s\S]*DO NOT USE WHEN:[\s\S]*create_rfq/);
    });
    it('swap_execute description states real-funds confirm + sealed limit semantics', () => {
      expect(source).toMatch(/swap_execute[\s\S]*limit_price[\s\S]*(SELL|floor)/);
      expect(source).toMatch(/swap_execute[\s\S]*Real funds/);
    });
    it('swap_execute warns accepted_amount may exceed requested (full-fill v1)', () => {
      expect(source).toMatch(/accepted_amount may EXCEED your requested amount/);
    });
    it('swap_quote declares the private (Ghost Auction) default ON', () => {
      expect(source).toMatch(/private[\s\S]*default[\s\S]*(true|ON)/i);
    });
    it('create_rfq intent-compiler remains byte-stable (unchanged Layer-1 pins)', () => {
      expect(source).toContain('INTENT → PARAMS MAPPING');
      expect(source).toMatch(/RESTATE/);
    });
  });

  // ─── Error scenarios ───────────────────────────────────

  describe('error handling', () => {
    it('should throw on GraphQL errors', async () => {
      const fetchFn = mockFetch({ errors: [{ message: 'Unauthorized' }] });
      const hl = createSDK(fetchFn);

      await expect(hl.createRFQ({ baseToken: 'ETH', quoteToken: 'USDT', side: 'SELL', amount: '1' }))
        .rejects.toThrow('Unauthorized');
    });

    it('should throw on HTTP 401', async () => {
      const fetchFn = mockFetch({}, 401);
      const hl = createSDK(fetchFn);

      await expect(hl.getHTLCStatus('t-1')).rejects.toThrow();
    });

    it('should throw on HTTP 500', async () => {
      const fetchFn = mockFetch({}, 500);
      const hl = createSDK(fetchFn);

      await expect(hl.fundHTLC({ tradeId: 't-1', txHash: '0x', role: 'INITIATOR' })).rejects.toThrow();
    });

    it('should throw on empty data response', async () => {
      const fetchFn = mockFetch({ data: null });
      const hl = createSDK(fetchFn);

      await expect(hl.getHTLCStatus('t-1')).rejects.toThrow();
    });
  });
});
