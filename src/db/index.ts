import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

/**
 * Build the postgres-js client, supporting two connectivity modes from a single
 * DATABASE_URL so the same image runs unchanged on Neon or Cloud SQL:
 *
 *   - TCP (Neon / local / most hosts):
 *       postgresql://USER:PASS@HOST:5432/DB?sslmode=require
 *
 *   - Cloud SQL Unix socket (Cloud Run inside the client's GCP):
 *       postgresql://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE
 *     Cloud Run mounts the Cloud SQL socket at /cloudsql/<connName> when the
 *     service is deployed with --add-cloudsql-instances. The connection is local,
 *     so TLS is disabled for this path.
 *
 * porsager/postgres does honor a `host` query param, but the empty-authority URL
 * form is ambiguous across versions, so we parse the socket case and pass
 * explicit options.
 */
export function createQueryClient(url: string) {
  const socketMatch = url.match(/[?&]host=([^&]*\/cloudsql\/[^&]+)/);
  if (socketMatch) {
    const socketPath = decodeURIComponent(socketMatch[1]);
    const parsed = new URL(url);
    return postgres({
      host: socketPath, // path starting with "/" → Unix socket
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || undefined,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      ssl: false,
    });
  }
  return postgres(url);
}

// For query purposes
const queryClient = createQueryClient(connectionString);
export const db = drizzle(queryClient, { schema });

/**
 * Admin connection for legitimately context-free paths (unauthenticated public
 * invoice reads, Stripe/PayPal capture handlers with no session). These queries
 * cannot set an org context, so they must NOT rely on the RLS IS NULL bypass.
 *
 * Until DATABASE_URL points at the non-owner app_runtime role, dbAdmin === db
 * behaviorally; after the flip, DATABASE_URL_ADMIN must be the owner/BYPASSRLS URL.
 */
const adminConnectionString = process.env.DATABASE_URL_ADMIN;
export const dbAdmin = adminConnectionString
  ? drizzle(createQueryClient(adminConnectionString), { schema })
  : db;

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbExecutor = typeof db | DrizzleTx;

/**
 * Execute a database operation with organization context for RLS.
 *
 * This sets PostgreSQL session variables that RLS policies use
 * to filter data by organization.
 *
 * @example
 * ```ts
 * const journals = await withOrgContext(orgId, userId, role, async () => {
 *   return db.select().from(journalHeaders);
 * });
 * ```
 */
export async function withOrgContext<T>(
  orgId: string,
  userId: string,
  role: string,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Keep the RLS context pinned to the same connection for all statements in this scope.
    await tx.execute(sql`
      SELECT 
        set_config('app.current_organization_id', ${orgId}, true),
        set_config('app.current_user_id', ${userId}, true),
        set_config('app.user_role', ${role}, true)
    `);

    return fn(tx);
  });
}

/**
 * Execute a database operation with USER context for RLS on per-user tables.
 *
 * Some tables (e.g. user_preferences) are keyed by user, not organization, so their
 * RLS policy is `user_id = current_user_id()`. Such queries have a valid session but
 * no active-org context, so they can't use withOrgContext. This sets only
 * app.current_user_id, pinned to the connection for the whole scope, so those
 * policies pass once FORCE ROW LEVEL SECURITY is enabled. It is a no-op today (RLS is
 * still permissive) but makes the path forward-safe.
 *
 * @example
 * ```ts
 * const prefs = await withUserContext(userId, (tx) =>
 *   tx.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
 * );
 * ```
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * Clear organization context (useful for admin operations).
 */
export async function clearOrgContext(): Promise<void> {
  await db.execute(sql`
    SELECT 
      set_config('app.current_organization_id', '', true),
      set_config('app.current_user_id', '', true),
      set_config('app.user_role', '', true)
  `);
}

// Export schema for use elsewhere
export { schema };
