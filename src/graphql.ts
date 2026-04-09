/**
 * Minimal GraphQL client for the MCP server.
 * No external dependencies — uses native fetch.
 */
export async function gql(
  endpoint: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HashLock API error (HTTP ${response.status}): ${text || response.statusText}`);
  }

  const json = await response.json() as { data?: Record<string, any>; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`HashLock API: ${json.errors.map((e: { message: string }) => e.message).join(', ')}`);
  }

  if (!json.data) {
    throw new Error('HashLock API returned empty response');
  }

  return json.data;
}
