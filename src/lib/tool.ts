import type { McpServer, ToolAnnotations, ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * registerTool for both servers, with the title taken from the annotations. Every output schema is a PASSTHROUGH
 * object: the SDK validates each non-error result against it on the server, and its client validates the JSON
 * Schema again — a plain raw shape converts to `additionalProperties: false`, so any field not declared would fail
 * a real client's call. Declare only what an agent acts on next, every field optional.
 */
export const toolRegistrar =
  (server: McpServer) =>
  <I extends z.ZodRawShape>(name: string, description: string, inputSchema: I, annotations: ToolAnnotations, outputSchema: z.ZodObject, cb: ToolCallback<z.ZodObject<I>>) =>
    server.registerTool(name, { title: annotations.title, description, inputSchema: dialectNeutral(z.object(inputSchema)), outputSchema, annotations }, cb);

/**
 * `schema`, listed with no `$schema`. The SDK has zod stamp draft 2020-12 on every tool schema (v1 stamped draft-07),
 * and a client that compiles tool schemas with a default, draft-07 Ajv throws on that URI. With no `$schema` each
 * validator applies its own default (draft-07 in a 2025-era client, 2020-12 from MCP 2025-11-25), and these schemas
 * use only keywords that mean the same in both: no tuple `items` and no `prefixItems`. Validation stays zod's.
 * It rewires the object it is given, so call it once, on a schema just made: the hosted server registers its tools on
 * every request, and the output schemas it shares across requests are made neutral once, by `output`.
 */
function dialectNeutral<S extends z.ZodType>(schema: S): S {
  const std = schema['~standard'];
  const neutral =
    (convert: typeof std.jsonSchema.input): typeof std.jsonSchema.input =>
    (options) => {
      const { $schema: _, ...json } = convert(options);
      return json;
    };
  schema['~standard'] = { ...std, jsonSchema: { input: neutral(std.jsonSchema.input), output: neutral(std.jsonSchema.output) } };
  return schema;
}

/** An output schema: the declared fields, every one optional, anything else passed through. */
export const output = (shape: z.ZodRawShape) => dialectNeutral(z.object(shape).partial().passthrough());

// Field types. A declared type must accept every value its producer can send: a mismatch turns a call that already
// happened (a write included) into an error the agent may retry.
/** A string the code proves is never null: one this server builds, or a NOT NULL column. */
export const s = () => z.string();
export const ns = () => z.string().nullable();
/** An amount, fee or count from a producer this server does not own — sent as a string by one route, a number by another. */
export const scalar = () => z.union([z.string(), z.number()]).nullable();
