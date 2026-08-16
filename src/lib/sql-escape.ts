/**
 * Escape LIKE/ILIKE metacharacters in a value that is meant to be matched
 * literally. Drizzle parameterizes values (so this is not about SQL injection),
 * but `%`, `_`, and `\` remain active *within* a LIKE pattern — so an
 * OCR/user-derived string like "50% Off" would otherwise match unrelated rows.
 *
 * Use for the dynamic part of a pattern:
 *   ilike(col, escapeLikePattern(name))                 // exact (case-insensitive)
 *   ilike(col, `%${escapeLikePattern(name)}%`)          // contains
 *
 * Uses the SQL-standard backslash escape character (Postgres LIKE default).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
