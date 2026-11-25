import { format } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { classifyError, logSdkError, wrapTool } from '../lib/errors.js';

describe('logSdkError', () => {
  const logged = (e: unknown): string[] => {
    const lines: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(format(...args)));
    try {
      logSdkError(e);
    } finally {
      error.mockRestore();
    }
    return lines;
  };

  it('logs a failure of ours as one line that names its file and line, and its cause', () => {
    const lines = logged(new Error('the factory failed', { cause: new TypeError('no key') }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toMatch(/^\[hashlock-mcp\] "Error: the factory failed\\n +at .*errors\.test\.ts:\d+:\d+/);
    expect(lines[0]).toMatch(/\[cause\]: TypeError: no key\\n +at /);
  });

  it('bounds the line whatever the error quotes, and keeps the head and the last frame', () => {
    const e = new Error(`Unsupported protocol version: ${'\u0001\n'.repeat(500_000)}`);
    const lines = logged(e);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]!.length).toBeLessThan(20_000);
    expect(lines[0]).toMatch(/^\[hashlock-mcp\] "Error: Unsupported protocol version: /);
    expect(lines[0]).toMatch(/…\(\d+ chars\)… /);
    expect(lines[0]!.endsWith(`${JSON.stringify(e.stack!.split('\n').at(-1)).slice(1, -1)}"`)).toBe(true);
  });

  it("keeps the frames of an error whose text is not its stack's first line (a ZodError's)", () => {
    class Issues extends Error {
      override toString() {
        return '[{"code":"invalid_type"}]';
      }
    }
    expect(logged(new Issues('bad message'))[0]).toMatch(/at .*errors\.test\.ts:\d+:\d+/);
  });

  it('never throws, whatever it is given', () => {
    const hostile = new Error('x', { cause: Object.create(null) });
    Object.defineProperty(hostile, 'name', { get: () => { throw new Error('getter'); } });
    const unprintable = new Proxy({}, { get: () => { throw new Error('trap'); }, getPrototypeOf: () => { throw new Error('trap'); } });
    for (const e of [hostile, Object.create(null), { toString: () => { throw new Error('toString'); } }, undefined, unprintable])
      expect(() => logged(e)).not.toThrow();
  });
});

describe('classifyError', () => {
  it('maps GraphQL field-validation / not-found language to NOT_FOUND', () => {
    const c = classifyError(new Error('No trade found for tradeId xyz'));
    expect(c.code).toBe('NOT_FOUND');
    expect(c.is_retryable).toBe(false);
    expect(c.recovery_hint).toMatch(/my_rfqs|my_deals|verify the id/i);
  });

  it('maps Unauthorized to UNAUTHORIZED', () => {
    expect(classifyError(new Error('Unauthorized – missing api-token')).code).toBe('UNAUTHORIZED');
  });

  it('maps HTTP 429 / rate language to RATE_LIMITED (retryable)', () => {
    const c = classifyError(new Error('Request failed: 429 Too Many Requests'));
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.is_retryable).toBe(true);
  });

  it('maps 5xx / rpc language to UPSTREAM_RPC_ERROR (retryable)', () => {
    const c = classifyError(new Error('Request failed: 502 Bad Gateway'));
    expect(c.code).toBe('UPSTREAM_RPC_ERROR');
    expect(c.is_retryable).toBe(true);
  });

  it('maps expired RFQ language to RFQ_EXPIRED', () => {
    expect(classifyError(new Error('RFQ has expired')).code).toBe('RFQ_EXPIRED');
  });

  it('falls back to UNKNOWN without masking the original message', () => {
    const c = classifyError(new Error('totally novel boom'));
    expect(c.code).toBe('UNKNOWN');
    expect(c.is_retryable).toBe(false);
  });

  // Issue 1 regression tests: bare /50\d/ and bare /network/ false-positives
  it('does NOT classify "amount 500 invalid" as UPSTREAM — bare 50x must not match validation messages', () => {
    const c = classifyError(new Error('amount 500 invalid'));
    expect(c.code).toBe('VALIDATION_ERROR');
    expect(c.is_retryable).toBe(false);
  });

  it('does NOT classify "unsupported network" as UPSTREAM — bare /network/ must not match validation phrases', () => {
    const c = classifyError(new Error('unsupported network'));
    expect(c.code).toBe('VALIDATION_ERROR');
  });

  it('still classifies transient "network request failed" as UPSTREAM_RPC_ERROR (retryable)', () => {
    const c = classifyError(new Error('network request failed'));
    expect(c.code).toBe('UPSTREAM_RPC_ERROR');
    expect(c.is_retryable).toBe(true);
  });

  it('still classifies "502 Bad Gateway" as UPSTREAM_RPC_ERROR (retryable) — regression guard', () => {
    const c = classifyError(new Error('Request failed: 502 Bad Gateway'));
    expect(c.code).toBe('UPSTREAM_RPC_ERROR');
    expect(c.is_retryable).toBe(true);
  });
});

describe('wrapTool', () => {
  it('passes through a successful handler result unchanged', async () => {
    const wrapped = wrapTool(async (x: number) => ({ content: [{ type: 'text', text: String(x) }], structuredContent: { x } }));
    expect(await wrapped(5)).toEqual({ content: [{ type: 'text', text: '5' }], structuredContent: { x: 5 } });
  });

  it('converts a thrown error into a structured envelope as tool content', async () => {
    const wrapped = wrapTool(async () => { throw new Error('No trade found for tradeId zzz'); });
    const out = await wrapped();
    const payload = JSON.parse(out.content[0].text);
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(payload.error.is_retryable).toBe(false);
    expect(typeof payload.error.recovery_hint).toBe('string');
    expect(payload.error.message).toContain('No trade found');
    expect(out.structuredContent).toEqual(payload);
  });

  it('converts a non-Error throw (plain string) into a structured envelope', async () => {
    const wrapped = wrapTool(async () => { throw 'plain string boom'; });
    const out = await wrapped();
    const payload = JSON.parse(out.content[0].text);
    expect(payload.error.message).toContain('plain string boom');
    expect(payload.error.code).toBe('UNKNOWN');
  });
});

describe('non-Error object throwables', () => {
  it('classifyError extracts .message from a plain object (not [object Object])', () => {
    const c = classifyError({ message: 'No trade found for tradeId q' });
    expect(c.code).toBe('NOT_FOUND');
  });

  it('wrapTool preserves .message from a thrown plain object', async () => {
    const wrapped = wrapTool(async () => { throw { message: 'custom object failure' }; });
    const out = await wrapped();
    const payload = JSON.parse(out.content[0].text);
    expect(payload.error.message).toBe('custom object failure');
    expect(payload.error.code).toBe('UNKNOWN');
  });
});
