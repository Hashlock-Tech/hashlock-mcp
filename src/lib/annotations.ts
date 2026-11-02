import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP tool annotations for both servers (stdio and hosted) — hints a client shows or acts on: a destructive tool asks
 * before it runs. Destructive here: it moves money, reveals the swap secret, binds this side to a price, cancels or
 * overwrites. TDQS (Glama's tool-definition score) reads them too.
 */
export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const ann = (title: string, base: ToolAnnotations, over: Partial<ToolAnnotations> = {}): ToolAnnotations => ({ title, ...base, ...over });
