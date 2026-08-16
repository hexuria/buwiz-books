// ============================================================================
// Zod → OpenAI strict JSON Schema.
//
// OpenAI's `strict: true` json_schema mode is narrower than plain JSON Schema:
//   • every object must set additionalProperties: false
//   • every property must appear in `required` — optionality is expressed by
//     making the type nullable instead
//   • unsupported keywords (minimum/maximum/minLength/pattern/format/default)
//     are rejected outright
//
// Those constraints ARE the three-provider intersection the architecture
// asks task schemas to respect (§5): whatever is stripped here must have a
// post-parse validator, because the same Zod schema re-validates the output
// anyway.
// ============================================================================

import { z } from "zod";

type JsonSchemaNode = Record<string, unknown>;

/** Keywords OpenAI strict mode rejects; app-side Zod still enforces them. */
const STRIPPED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "default",
  "minItems",
  "maxItems",
  "uniqueItems",
  "$schema",
] as const;

function strip(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if ((STRIPPED_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function walk(
  node: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
  depth = 0,
): JsonSchemaNode {
  if (depth > 12)
    throw new Error("toStrictJsonSchema: schema nested too deeply (possible recursion)");

  // Resolve $ref inline — strict mode dislikes cross-references.
  const ref = node.$ref;
  if (typeof ref === "string") {
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    if (!match || !defs[match[1]]) throw new Error(`toStrictJsonSchema: unresolvable $ref ${ref}`);
    const { $ref: _drop, ...siblings } = node;
    return walk({ ...defs[match[1]], ...siblings }, defs, depth + 1);
  }

  const cleaned = strip(node);

  // anyOf/oneOf: recurse into each branch.
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = cleaned[key];
    if (Array.isArray(branches)) {
      cleaned[key] = branches.map((b) => walk(b as JsonSchemaNode, defs, depth + 1));
    }
  }

  if (cleaned.type === "array" && cleaned.items) {
    cleaned.items = walk(cleaned.items as JsonSchemaNode, defs, depth + 1);
  }

  if (cleaned.type === "object") {
    const properties = (cleaned.properties ?? {}) as Record<string, JsonSchemaNode>;
    const walked: Record<string, JsonSchemaNode> = {};
    for (const [key, child] of Object.entries(properties)) {
      walked[key] = walk(child, defs, depth + 1);
    }
    cleaned.properties = walked;
    // strict mode: ALL properties required, optionality via nullable.
    cleaned.required = Object.keys(walked);
    cleaned.additionalProperties = false;
  }

  return cleaned;
}

/**
 * Convert a Zod schema to an OpenAI strict-mode JSON Schema.
 * Throws for constructs strict mode cannot express, so incompatibilities
 * surface in tests rather than at request time.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as JsonSchemaNode;
  const defs = (jsonSchema.$defs ?? {}) as Record<string, JsonSchemaNode>;
  const { $defs: _drop, ...root } = jsonSchema;
  return walk(root, defs);
}
