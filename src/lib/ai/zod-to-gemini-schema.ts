// ============================================================================
// Zod → Gemini responseSchema conversion.
//
// Zod output schemas (src/lib/ai/schemas/*) are the single source of truth for
// model output shape. This converts them to the Gemini OpenAPI subset via
// Zod 4's native z.toJSONSchema plus a lowering pass:
//   • string enums → { type: "string", format: "enum", enum }
//   • anyOf where every branch is a string (e.g. ymd-or-empty) → plain string
//   • anyOf [T, null] → T with nullable: true
//   • tuples → plain arrays of the element type (Gemini can't fix length;
//     Zod re-validates the exact arity app-side)
//   • $refs resolved inline; pattern/min/max/default stripped (app-side Zod
//     enforces them — Gemini only guarantees syntax)
//
// Unsupported constructs (unions of mixed types, records, recursion) THROW —
// and every task schema is converted at module load in the prompt registry,
// so an incompatibility fails typecheck/CI, never a production request.
// ============================================================================

import { z } from "zod";

/** Gemini OpenAPI-subset schema node (matches @google/generative-ai Schema). */
export interface GeminiSchema {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  format?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
}

type JsonSchemaNode = Record<string, unknown>;

export class GeminiSchemaConversionError extends Error {
  constructor(message: string, path: string) {
    super(`zodToGeminiSchema: ${message} (at ${path || "(root)"})`);
    this.name = "GeminiSchemaConversionError";
  }
}

function resolveRef(node: JsonSchemaNode, defs: Record<string, JsonSchemaNode>): JsonSchemaNode {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!match || !defs[match[1]]) {
    throw new GeminiSchemaConversionError(`unresolvable $ref "${ref}"`, "");
  }
  // Merge sibling keys (description overrides) over the resolved target.
  const { $ref: _r, ...siblings } = node;
  return { ...defs[match[1]], ...siblings };
}

function isNullBranch(node: JsonSchemaNode): boolean {
  return node.type === "null";
}

function lower(
  rawNode: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
  path: string,
  depth: number,
): GeminiSchema {
  if (depth > 12) {
    throw new GeminiSchemaConversionError("nesting too deep (possible recursion)", path);
  }
  const node = resolveRef(rawNode, defs);
  const description = typeof node.description === "string" ? node.description : undefined;

  // anyOf handling: nullable unions and all-string unions only.
  const anyOf = (node.anyOf ?? node.oneOf) as JsonSchemaNode[] | undefined;
  if (Array.isArray(anyOf)) {
    const branches = anyOf.map((b) => resolveRef(b, defs));
    const nonNull = branches.filter((b) => !isNullBranch(b));
    if (nonNull.length === 1 && branches.length === 2) {
      const inner = lower(nonNull[0], defs, path, depth + 1);
      return { ...inner, nullable: true, ...(description ? { description } : {}) };
    }
    const allStrings = branches.every((b) => {
      const resolved = resolveRef(b, defs);
      return resolved.type === "string" || typeof resolved.const === "string";
    });
    if (allStrings) {
      return { type: "string", ...(description ? { description } : {}) };
    }
    throw new GeminiSchemaConversionError("unions of mixed types are not supported", path);
  }

  if (typeof node.const === "string") {
    return {
      type: "string",
      format: "enum",
      enum: [node.const],
      ...(description ? { description } : {}),
    };
  }

  const type = node.type;
  switch (type) {
    case "string": {
      const values = node.enum as unknown[] | undefined;
      if (Array.isArray(values)) {
        if (!values.every((v) => typeof v === "string")) {
          throw new GeminiSchemaConversionError("non-string enum values", path);
        }
        return {
          type: "string",
          format: "enum",
          enum: values as string[],
          ...(description ? { description } : {}),
        };
      }
      return { type: "string", ...(description ? { description } : {}) };
    }
    case "number":
    case "integer":
    case "boolean":
      return { type, ...(description ? { description } : {}) };
    case "array": {
      // Tuples (prefixItems) collapse to a plain array of the first element
      // type — Gemini can't pin arity; Zod re-validates it app-side.
      const prefixItems = node.prefixItems as JsonSchemaNode[] | undefined;
      const items = (node.items ?? prefixItems?.[0]) as JsonSchemaNode | undefined;
      if (!items) {
        throw new GeminiSchemaConversionError("array without items", path);
      }
      return {
        type: "array",
        items: lower(items, defs, `${path}[]`, depth + 1),
        ...(description ? { description } : {}),
      };
    }
    case "object": {
      const properties = (node.properties ?? {}) as Record<string, JsonSchemaNode>;
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        throw new GeminiSchemaConversionError("records / additionalProperties schemas", path);
      }
      const loweredProps: Record<string, GeminiSchema> = {};
      for (const [key, child] of Object.entries(properties)) {
        loweredProps[key] = lower(child, defs, path ? `${path}.${key}` : key, depth + 1);
      }
      const required = (node.required as string[] | undefined)?.filter((k) => k in loweredProps);
      return {
        type: "object",
        properties: loweredProps,
        ...(required && required.length > 0 ? { required } : {}),
        ...(description ? { description } : {}),
      };
    }
    default:
      throw new GeminiSchemaConversionError(`unsupported node type "${String(type)}"`, path);
  }
}

/**
 * Convert a Zod schema to a Gemini responseSchema.
 * Throws GeminiSchemaConversionError for constructs Gemini cannot express —
 * call at module load so incompatibilities fail in CI, not at runtime.
 */
export function zodToGeminiSchema(schema: z.ZodType): GeminiSchema {
  // io: "input" — the model's raw JSON is the INPUT to safeParse, so fields
  // with .default()/.catch() are optional for the model to emit (matching the
  // hand-built responseSchema literals' required lists).
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as JsonSchemaNode;
  const defs = (jsonSchema.$defs ?? {}) as Record<string, JsonSchemaNode>;
  return lower(jsonSchema, defs, "", 0);
}
