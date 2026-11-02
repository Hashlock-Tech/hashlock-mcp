/**
 * MCP tool content helpers. Pure + unit-testable so handler-shape behavior
 * (success envelope, and the error envelope built on top in lib/errors.ts)
 * can be asserted without booting the MCP stdio server.
 */
export type ToolContent = { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> };

export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A value as structuredContent, which must be an object: an array is `{ items }`, anything else that is not an
 *  object (null, a primitive, nothing) is `{ value }`. The one rule for both servers. */
export const toStructured = (value: unknown): Record<string, unknown> => (Array.isArray(value) ? { items: value } : isObject(value) ? value : { value });

/** The text is the value as JSON (nothing reads as null — a missing value must not leave the text empty);
 *  structuredContent is the same value (toStructured). */
export function okContent(value: unknown): ToolContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
    structuredContent: toStructured(value),
  };
}
