/**
 * Tiny per-request client for the Hashlock **developer API (`/v1`)** — the surface the HOSTED MCP
 * proxies to. Unlike the stdio server's HashlockClient (which speaks the wallet-JWT `/api` and signs
 * autonomously with env keys), this forwards the CALLER's own `hk_` API key as a bearer token and
 * never holds keys or secrets. Settlement routes return unsigned transactions; the caller signs.
 */
export type CallV1 = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: unknown }>;

/**
 * How long /v1 gets to answer everything ONE MCP request asks of it, headers and bodies. Without a limit
 * a /v1 that stopped answering held every tool call, and the stream it answers on, open for as long as
 * the client waited. Just under the 60 s an MCP client waits by default, so the agent hears THIS —
 * whether the call may have taken effect — instead of its own bare timeout. /v1's own waits on chains
 * and explorers are 15–20 s each and end in a 504 of its own, which arrives here as any other answer.
 */
const V1_TIMEOUT_MS = 55_000;

/** Build a CallV1 bound to a base URL and one caller's bearer token — one per MCP request. */
export function makeCallV1(baseUrl: string, token: string, timeoutMs = V1_TIMEOUT_MS): CallV1 {
  const base = baseUrl.replace(/\/+$/, '');
  const signal = AbortSignal.timeout(timeoutMs); // one clock for the request, however many calls its tool makes
  return async (path, init) => {
    const method = init?.method ?? 'GET';
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-hashlock-client': 'mcp',
          authorization: `Bearer ${token}`,
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal,
      });
      // Read as text first: a timeout while the body arrives must reach the catch below, not be reported
      // as a body that was not JSON.
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) as unknown };
      } catch {
        return { status: res.status, json: { error: `non-JSON ${res.status} response` } };
      }
    } catch (e) {
      // No answer came back, in time or at all. Which of the two does not change what the agent must do:
      // a read changed nothing, and a write may have landed before the line went quiet — a connection
      // reset mid-request is as open a question as a timeout. Said here, not left to a bare "fetch failed".
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      const what = timedOut ? `the Hashlock API did not answer in ${Math.round(timeoutMs / 1000)} s` : 'the Hashlock API could not be reached';
      const error =
        method === 'GET'
          ? `${what} — nothing was changed; try again`
          : `${what} — this call may or may not have taken effect: read the request or the swap before sending it again`;
      return { status: timedOut ? 504 : 502, json: { error } };
    }
  };
}
