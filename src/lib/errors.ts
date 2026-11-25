import { inspect } from 'node:util';
import { okContent, type ToolContent } from './result.js';

const LOG_PART = 1500;

/**
 * An error the SDK reports (onerror), as ONE stderr line, both servers: util.inspect of it (stack, cause chain, other
 * fields such as a ZodError's issues), JSON-encoded, clipped to its first and last LOG_PART characters. Most errors are
 * requests the SDK refused (an empty batch, a bad header, an unsupported protocol version), which any caller can send,
 * and some quote the caller's own text: encoded, a newline in it cannot forge a log line, and clipped, a 1 MB protocol
 * version is not a 1 MB log line. It never throws: on stdio, onerror runs where nothing catches.
 */
export const logSdkError = (e: unknown): void => {
  let text: string;
  try {
    text = inspect(e, { depth: 3, breakLength: Infinity, maxStringLength: 4 * LOG_PART, maxArrayLength: 50 });
  } catch {
    try {
      text = String((e as { stack?: unknown })?.stack ?? Object.prototype.toString.call(e));
    } catch {
      text = '[an error that cannot be printed]';
    }
  }
  if (text.length > 2 * LOG_PART) text = `${text.slice(0, LOG_PART)} …(${text.length} chars)… ${text.slice(-LOG_PART)}`;
  console.error('[hashlock-mcp]', JSON.stringify(text));
};

export type ErrorCode =
  | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'UNAUTHORIZED'
  | 'RATE_LIMITED' | 'UPSTREAM_RPC_ERROR' | 'RFQ_EXPIRED'
  | 'NO_LIQUIDITY' | 'UNKNOWN';

export interface Classification {
  code: ErrorCode;
  is_retryable: boolean;
  recovery_hint: string;
}

const RULES: { test: RegExp; code: ErrorCode; is_retryable: boolean; recovery_hint: string }[] = [
  // First, because a Bankr message is Bankr's own text ("MFA required", "Invalid API key"), which the
  // rules below would read as a bad argument. (The status-code rules match whole numbers only: a
  // transaction hash in a message is not a 429.)
  { test: /\bBankr\b/, code: 'UNKNOWN', is_retryable: false,
    recovery_hint: 'The Bankr wallet refused or could not be reached. The message names the cause — the Bankr API key, a Bankr security setting or limit, or the network — and says so if a transaction may have been sent. Fix the cause in Bankr, and check the swap (deal_status) before repeating a write.' },
  { test: /unauthor|missing api-token|forbidden|\b401\b/i, code: 'UNAUTHORIZED', is_retryable: false,
    recovery_hint: 'Set HASHLOCK_TOKEN (a JWT), or a wallet for autonomous SIWE login — HASHLOCK_EVM_KEY (0x private key) or HASHLOCK_BANKR_API_KEY (a Bankr wallet) — and retry.' },
  { test: /\b429\b|too many requests|rate.?limit/i, code: 'RATE_LIMITED', is_retryable: true,
    recovery_hint: 'Back off and retry after a short delay.' },
  { test: /(?:status|code|http|failed:?)\s*5\d{2}\b|\b5\d{2}\b\s*(?:internal server error|bad gateway|service unavailable|gateway timeout)|internal server error|bad gateway|service unavailable|gateway timeout|upstream|\brpc\b|econnreset|etimedout|fetch failed|network (?:error|request failed|timeout)/i, code: 'UPSTREAM_RPC_ERROR', is_retryable: true,
    recovery_hint: 'Transient upstream/RPC failure. Retry with backoff; if persistent, the backend or a chain RPC is degraded.' },
  { test: /rfq.*expire|expired.*rfq|quote.*expired/i, code: 'RFQ_EXPIRED', is_retryable: false,
    recovery_hint: 'The RFQ/quote window closed. Create a fresh RFQ with create_rfq.' },
  { test: /no (liquidity|maker|quote)|insufficient liquidity|no counterparty/i, code: 'NO_LIQUIDITY', is_retryable: false,
    recovery_hint: 'Nobody has responded yet. Post a public RFQ with create_rfq and wait, or respond to an existing one from list_open_rfqs.' },
  { test: /not found|no trade|unknown trade|does not exist|cannot query field/i, code: 'NOT_FOUND', is_retryable: false,
    recovery_hint: 'Verify the id via my_rfqs / my_deals / list_open_rfqs, or re-create the request.' },
  { test: /invalid|validation|must be|required|bad request|\b400\b|unsupported|not a valid/i, code: 'VALIDATION_ERROR', is_retryable: false,
    recovery_hint: 'Fix the offending argument and retry. Check assets/chains via list_assets.' },
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
