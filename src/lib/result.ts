/**
 * MCP tool content helpers. Pure + unit-testable so handler-shape behavior
 * (success envelope, and the error envelope built on top in lib/errors.ts)
 * can be asserted without booting the MCP stdio server.
 */
export type ToolContent = { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> };

/** The text is the value as JSON; structuredContent is the same value, an array as `{ items }` (it must be an object). */
export function okContent(value: unknown): ToolContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: Array.isArray(value) ? { items: value } : (value as Record<string, unknown>),
  };
}
