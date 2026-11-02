import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * registerTool for both servers, with the title taken from the annotations. Every output schema is a PASSTHROUGH
 * object: the SDK validates each non-error result against it on the server, and its client validates the JSON
 * Schema again — a plain raw shape converts to `additionalProperties: false`, so any field not declared would fail
 * a real client's call. Declare only what an agent acts on next, every field optional.
 */
export const toolRegistrar =
  (server: McpServer) =>
  <I extends ZodRawShapeCompat>(name: string, description: string, inputSchema: I, annotations: ToolAnnotations, outputSchema: z.AnyZodObject, cb: ToolCallback<I>) =>
    server.registerTool(name, { title: annotations.title, description, inputSchema, outputSchema, annotations }, cb);

/** An output schema: the declared fields, every one optional, anything else passed through. */
export const output = (shape: z.ZodRawShape) => z.object(shape).partial().passthrough();

// Field types. A declared type must accept every value its producer can send: a mismatch turns a call that already
// happened (a write included) into an error the agent may retry. A fresh instance per field: one shared instance is
// emitted as a $ref to another field.
/** A string the code proves is never null: one this server builds, or a NOT NULL column. */
export const s = () => z.string();
export const ns = () => z.string().nullable();
/** An amount, fee or count from a producer this server does not own — sent as a string by one route, a number by another. */
export const scalar = () => z.union([z.string(), z.number()]).nullable();
