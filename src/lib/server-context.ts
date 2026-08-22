import { getRequest } from "@tanstack/react-start/server";
import { withOrgContext, withUserContext, type DbExecutor } from "@/db";
import { requireSession, type SessionContext } from "@/lib/auth-middleware";
import type { MutationGuardOptions } from "@/lib/request-guards";
import type { Action, Resource } from "@/lib/permissions";

type GuardConfig = Omit<MutationGuardOptions, "orgId" | "userId">;

export interface OrgServerContext extends SessionContext {
  db: DbExecutor;
  headers: Headers;
  request: Request | null;
}

export interface UserServerContext {
  session: Awaited<ReturnType<typeof requireSession>>;
  userId: string;
  db: DbExecutor;
  headers: Headers;
  request: Request | null;
}

function getRequestHeaders(): Headers {
  return getRequest()?.headers ?? new Headers();
}

async function runWithOrgContext<T>(
  session: SessionContext,
  fn: (ctx: OrgServerContext) => Promise<T>,
  guard?: GuardConfig,
): Promise<T> {
  if (guard) {
    const { guardMutationRequest } = await import("@/lib/request-guards");
    guardMutationRequest({
      ...guard,
      orgId: session.orgId,
      userId: session.userId,
    });
  }

  const request = getRequest() ?? null;
  const headers = request?.headers ?? new Headers();

  try {
    return await withOrgContext(session.orgId, session.userId, session.role, async (database) =>
      fn({
        ...session,
        db: database,
        headers,
        request,
      }),
    );
  } catch (error: any) {
    // Sanitize Drizzle raw SQL query errors to prevent UI leaks
    if (error instanceof Error && error.message.includes("Failed query:")) {
      console.error("[Database Error]", error.message);
      throw new Error("A database error occurred while processing your request. Please try again.");
    }
    throw error;
  }
}

async function runWithUserContext<T>(
  session: Awaited<ReturnType<typeof requireSession>>,
  fn: (ctx: UserServerContext) => Promise<T>,
  mutation?: { scope: string; guard: GuardConfig },
): Promise<T> {
  const request = getRequest() ?? null;
  const headers = request?.headers ?? new Headers();
  const userId = session.user.id;

  if (mutation) {
    const { guardMutationRequest } = await import("@/lib/request-guards");
    guardMutationRequest({
      ...mutation.guard,
      orgId: mutation.scope,
      userId,
    });
  }

  try {
    return await withUserContext(userId, (database) =>
      fn({ session, userId, db: database, headers, request }),
    );
  } catch (error: any) {
    if (error instanceof Error && error.message.includes("Failed query:")) {
      console.error("[Database Error]", error.message);
      throw new Error("A database error occurred while processing your request. Please try again.");
    }
    throw error;
  }
}

/**
 * Request-scoped wrapper for authenticated, user-owned data that deliberately
 * spans organizations (for example an Enterprise Business Group portfolio).
 */
export async function withSessionUserContext<T>(
  fn: (ctx: UserServerContext) => Promise<T>,
): Promise<T> {
  const headers = getRequestHeaders();
  const session = await requireSession(headers);
  return runWithUserContext(session, fn);
}

/** User-scoped mutation wrapper with the same guard semantics as org writes. */
export async function withMutationSessionUserContext<T>(
  scope: string,
  guard: GuardConfig,
  fn: (ctx: UserServerContext) => Promise<T>,
): Promise<T> {
  const headers = getRequestHeaders();
  const session = await requireSession(headers);
  return runWithUserContext(session, fn, { scope, guard });
}

export async function withSessionOrgContext<T>(
  fn: (ctx: OrgServerContext) => Promise<T>,
): Promise<T> {
  const headers = getRequestHeaders();
  const { getSessionContext } = await import("@/lib/auth-middleware");
  const session = await getSessionContext(headers);
  return runWithOrgContext(session, fn);
}

export async function withPermissionOrgContext<R extends Resource, T>(
  resource: R,
  action: Action<R>,
  fn: (ctx: OrgServerContext) => Promise<T>,
): Promise<T> {
  const headers = getRequestHeaders();
  const { requirePermission } = await import("@/lib/auth-middleware");
  const session = await requirePermission(headers, resource, action);
  return runWithOrgContext(session, fn);
}

export async function withMutationPermissionOrgContext<R extends Resource, T>(
  resource: R,
  action: Action<R>,
  guard: GuardConfig,
  fn: (ctx: OrgServerContext) => Promise<T>,
): Promise<T> {
  const headers = getRequestHeaders();
  const { requirePermission } = await import("@/lib/auth-middleware");
  const session = await requirePermission(headers, resource, action);
  return runWithOrgContext(session, fn, guard);
}
