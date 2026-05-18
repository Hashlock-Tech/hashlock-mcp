import { okContent, type ToolContent } from './result.js';

export type ErrorCode =
  | 'TRADE_NOT_FOUND' | 'VALIDATION_ERROR' | 'UNAUTHORIZED'
  | 'RATE_LIMITED' | 'UPSTREAM_RPC_ERROR' | 'RFQ_EXPIRED'
  | 'NO_LIQUIDITY' | 'UNKNOWN';

export interface Classification {
  code: ErrorCode;
  is_retryable: boolean;
  recovery_hint: string;
}

const RULES: { test: RegExp; code: ErrorCode; is_retryable: boolean; recovery_hint: string }[] = [
  { test: /unauthor|missing api-token|forbidden|401/i, code: 'UNAUTHORIZED', is_retryable: false,
    recovery_hint: 'Set a valid HASHLOCK_ACCESS_TOKEN (bearer from hashlock.markets/sign/login) and retry.' },
  { test: /429|too many requests|rate.?limit/i, code: 'RATE_LIMITED', is_retryable: true,
    recovery_hint: 'Back off and retry after a short delay.' },
  { test: /50\d|bad gateway|gateway timeout|upstream|rpc|econnreset|fetch failed|network/i, code: 'UPSTREAM_RPC_ERROR', is_retryable: true,
    recovery_hint: 'Transient upstream/RPC failure. Retry with backoff; if persistent, the backend or a chain RPC is degraded.' },
  { test: /rfq.*expire|expired.*rfq|quote.*expired/i, code: 'RFQ_EXPIRED', is_retryable: false,
    recovery_hint: 'The RFQ/quote window closed. Create a fresh RFQ with create_rfq.' },
  { test: /no (liquidity|maker|quote)|insufficient liquidity|no counterparty/i, code: 'NO_LIQUIDITY', is_retryable: false,
    recovery_hint: 'No market-maker coverage for this size/pair. Try a smaller size, a major pair, or widen expiresIn.' },
  { test: /not found|no trade|unknown trade|does not exist|cannot query field/i, code: 'TRADE_NOT_FOUND', is_retryable: false,
    recovery_hint: 'Verify the tradeId/rfqId via list_my_trades or list_open_rfqs, or re-create the request.' },
  { test: /invalid|validation|must be|required|bad request|400|unsupported|not a valid/i, code: 'VALIDATION_ERROR', is_retryable: false,
    recovery_hint: 'Fix the offending argument and retry. Check token/chain are in list_supported_pairs.' },
];

export function classifyError(err: unknown): Classification {
  const message = err instanceof Error ? err.message : String(err);
  for (const r of RULES) {
    if (r.test.test(message)) {
      return { code: r.code, is_retryable: r.is_retryable, recovery_hint: r.recovery_hint };
    }
  }
  return {
    code: 'UNKNOWN',
    is_retryable: false,
    recovery_hint: 'Unrecognized failure. Inspect the message; do not blindly retry a write.',
  };
}

export function toErrorEnvelope(err: unknown): ToolContent {
  const message = err instanceof Error ? err.message : String(err);
  const c = classifyError(err);
  return okContent({
    error: {
      code: c.code,
      message,
      is_retryable: c.is_retryable,
      recovery_hint: c.recovery_hint,
      details: {},
    },
  });
}

/** Wrap an MCP tool handler so thrown errors become a structured envelope. */
export function wrapTool<A extends unknown[]>(
  handler: (...args: A) => Promise<ToolContent>,
): (...args: A) => Promise<ToolContent> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      return toErrorEnvelope(err);
    }
  };
}
