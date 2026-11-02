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
