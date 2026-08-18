/**
 * Tiny per-request client for the Hashlock **developer API (`/v1`)** — the surface the HOSTED MCP
 * proxies to. Unlike the stdio server's HashlockClient (which speaks the wallet-JWT `/api` and signs
 * autonomously with env keys), this forwards the CALLER's own `hk_` API key as a bearer token and
 * never holds keys or secrets. Settlement routes return unsigned transactions; the caller signs.
 */
export type CallV1 = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: unknown }>;

/** Build a CallV1 bound to a base URL and one caller's bearer token. */
export function makeCallV1(baseUrl: string, token: string): CallV1 {
  const base = baseUrl.replace(/\/+$/, '');
  return async (path, init) => {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-hashlock-client': 'mcp',
        authorization: `Bearer ${token}`,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const json = await res.json().catch(() => ({ error: `non-JSON ${res.status} response` }));
    return { status: res.status, json };
  };
}
