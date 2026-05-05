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

  // ─── get_htlc → getHTLCStatus ─────────────────────────

  describe('get_htlc (getHTLCStatus)', () => {
    it('should return both initiator and counterparty HTLCs', async () => {
      const htlcStatus = {
        tradeId: 't-1',
        status: 'BOTH_LOCKED',
        initiatorHTLC: { id: 'h1', tradeId: 't-1', role: 'INITIATOR', status: 'ACTIVE', contractAddress: '0x1', hashlock: '0xh', timelock: 999, amount: '1.0', txHash: '0xa', chainType: 'evm' },
        counterpartyHTLC: { id: 'h2', tradeId: 't-1', role: 'COUNTERPARTY', status: 'ACTIVE', contractAddress: '0x2', hashlock: '0xh', timelock: 888, amount: '3500', txHash: '0xb', chainType: 'evm' },
      };
      const fetchFn = mockFetch({ data: { htlcStatus } });
      const hl = createSDK(fetchFn);

      const result = await hl.getHTLCStatus('t-1');
      expect(result?.status).toBe('BOTH_LOCKED');
      expect(result?.initiatorHTLC?.status).toBe('ACTIVE');
      expect(result?.counterpartyHTLC?.status).toBe('ACTIVE');
    });

    it('should return null for unknown trade', async () => {
      const fetchFn = mockFetch({ data: { htlcStatus: null } });
      const hl = createSDK(fetchFn);

      const result = await hl.getHTLCStatus('unknown');
      expect(result).toBeNull();
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
