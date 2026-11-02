import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { registerHostedTools } from '../http/tools.js';
import { registerTools } from '../tools.js';

// TDQS (Glama's tool-definition score): every tool says what it does to the world (annotations, with a title), and
// every parameter says what it is. A new tool or parameter without them fails here, not in a directory's score.
type Registered = { annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema?: { shape?: Record<string, { description?: string }> }; outputSchema?: unknown };
const toolsOf = (s: McpServer) => (s as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;

function stdio() {
  const s = new McpServer({ name: 't', version: '0' });
  registerTools(s, {} as never, {} as never, {} as never);
  return toolsOf(s);
}
function hosted() {
  const s = new McpServer({ name: 't', version: '0' });
  registerHostedTools(s, async () => ({ status: 200, json: {} }));
  return toolsOf(s);
}

// Every tool that moves money, reveals the swap secret, binds this side to a price, cancels or overwrites — by name, so a
// rename or a missing tool fails here instead of passing unchecked.
const DESTRUCTIVE = {
  stdio: ['fund_leg', 'claim_leg', 'refund_leg', 'get_deal_secret', 'reveal_claim', 'respond_to_rfq', 'negotiate', 'cancel_rfq', 'set_settlement_address'],
  hosted: ['build_claim', 'broadcast_tx', 'quote_rfq', 'propose_price', 'accept_proposal', 'accept_terms', 'cancel_rfq', 'set_swap_address', 'remove_wallet_proof'],
};

describe.each([
  ['stdio', stdio, 17],
  ['hosted', hosted, 24],
] as const)('%s tool definitions', (name, build, count) => {
  const tools = build();
  it(`registers ${count} tools, each with a title and read/destructive hints`, () => {
    expect(Object.keys(tools)).toHaveLength(count);
    for (const [name, t] of Object.entries(tools)) {
      expect(t.annotations?.title, name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, name).toBe('boolean');
      expect(typeof t.annotations?.destructiveHint, name).toBe('boolean');
      expect(t.outputSchema, name).toBeTruthy();
    }
  });
  it('describes every parameter', () => {
    for (const [name, t] of Object.entries(tools))
      for (const [param, schema] of Object.entries(t.inputSchema?.shape ?? {})) expect(schema.description, `${name}.${param}`).toBeTruthy();
  });
  it('marks exactly the tools that move money, reveal the secret, bind a price, cancel or overwrite as destructive', () => {
    const marked = Object.entries(tools).filter(([, t]) => t.annotations?.destructiveHint).map(([n]) => n);
    expect(marked.sort()).toEqual([...DESTRUCTIVE[name]].sort());
  });
});
