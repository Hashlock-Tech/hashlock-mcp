/**
 * MCP tool content helpers. Pure + unit-testable so handler-shape behavior
 * (success envelope, and the error envelope built on top in lib/errors.ts)
 * can be asserted without booting the MCP stdio server.
 */
export type ToolContent = { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> };

export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The text is the value as JSON; structuredContent is the same value — it must be an object, so an array is
 *  `{ items }` and anything else that is not an object (null, a primitive, nothing) is `{ value }`. */
export function okContent(value: unknown): ToolContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: Array.isArray(value) ? { items: value } : isObject(value) ? value : { value },
  };
}
