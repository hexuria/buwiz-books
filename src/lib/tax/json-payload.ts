/** JSON-safe payloads for tax_computed_returns. */
export type JsonScalarMap = Record<string, string | number | boolean | string[]>;

export function asJsonPayload(value: object): JsonScalarMap {
  return JSON.parse(JSON.stringify(value)) as JsonScalarMap;
}
