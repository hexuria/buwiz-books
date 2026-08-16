/**
 * JSON coercion for values crossing a server-function boundary.
 *
 * `jsonb` columns are typed `Record<string, unknown>` by Drizzle, which does not survive
 * serialization to the client. Round-tripping through JSON both narrows the type and drops
 * anything (Date, undefined, functions) that would serialize inconsistently.
 */
export type SerializableJson =
  | string
  | number
  | boolean
  | null
  | SerializableJson[]
  | { [key: string]: SerializableJson };

export function toSerializableRecord(value: unknown): Record<string, SerializableJson> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, SerializableJson>;
}
