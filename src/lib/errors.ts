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
  { test: /(?:status|code|http|failed:?)\s*5\d{2}\b|\b5\d{2}\b\s*(?:internal server error|bad gateway|service unavailable|gateway timeout)|internal server error|bad gateway|service unavailable|gateway timeout|upstream|\brpc\b|econnreset|etimedout|fetch failed|network (?:error|request failed|timeout)/i, code: 'UPSTREAM_RPC_ERROR', is_retryable: true,
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

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err
      && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

export function classifyError(err: unknown): Classification {
  const message = extractMessage(err);
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

/**
 * Converts any thrown value into a structured error envelope returned as normal
 * tool content (via `okContent`). This deliberately does NOT set MCP `isError:true`.
 *
 * Design rationale: returning the envelope as structured content — rather than as
 * an MCP protocol error — gives autonomous agents a machine-readable
 * `{ error: { code, message, is_retryable, recovery_hint } }` payload they can
 * branch on without parsing free-form error text. An MCP `isError:true` response
 * would surface as an opaque protocol fault to most agent runtimes, losing the
 * actionable classification. Do NOT add `isError:true` here; do NOT modify
 * `result.ts` to inject it.
 */
export function toErrorEnvelope(err: unknown): ToolContent {
  const message = extractMessage(err);
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

/**
 * Wrap an MCP tool handler so thrown errors become a structured envelope.
 * Errors are returned as normal tool content (not MCP `isError:true`) — see
 * `toErrorEnvelope` for the rationale.
 */
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
