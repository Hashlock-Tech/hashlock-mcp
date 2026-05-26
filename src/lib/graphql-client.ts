/**
 * Thin GraphQL HTTP client for MCP tools that call mutations not yet
 * covered by @hashlock-tech/sdk. Uses the same endpoint + bearer-token
 * scheme as the SDK's internal GraphQLClient, without the retry logic
 * (mutations must not be retried blindly — callers handle idempotency).
 *
 * The endpoint is read from the module-level ENDPOINT constant so that
 * tests can mock this module without touching globalThis.fetch.
 */

/** Re-exported so callers can reference the type without importing the full module. */
export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
}

export interface CallGraphQLOptions {
  /** Absolute URL to the GraphQL endpoint. Defaults to HASHLOCK_ENDPOINT env var or the prod endpoint. */
  endpoint?: string;
  /** Bearer token for Authorization header. Omit for public queries. */
  auth?: string;
  /** GraphQL query or mutation document. */
  query: string;
  /** GraphQL variables object. */
  variables?: Record<string, unknown>;
}

const DEFAULT_ENDPOINT =
  process.env.HASHLOCK_ENDPOINT || 'https://hashlock.markets/graphql';

/**
 * Execute a single GraphQL operation (query or mutation).
 *
 * - Throws on network/HTTP errors (let callers wrap in try/catch).
 * - Returns the raw `{ data?, errors? }` envelope on 2xx; callers must
 *   check `result.errors?.length` before accessing `result.data`.
 */
export async function callGraphQL<T = Record<string, unknown>>(
  options: CallGraphQLOptions,
): Promise<GraphQLResponse<T>> {
  const { endpoint = DEFAULT_ENDPOINT, auth, query, variables } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (auth) {
    headers['Authorization'] = `Bearer ${auth}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<GraphQLResponse<T>>;
}
