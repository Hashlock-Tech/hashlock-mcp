/**
 * MCP tool content helpers. Pure + unit-testable so handler-shape behavior
 * (success envelope, and the error envelope built on top in lib/errors.ts)
 * can be asserted without booting the MCP stdio server.
 */
export type ToolContent = { content: { type: 'text'; text: string }[] };

export function okContent(value: unknown): ToolContent {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
