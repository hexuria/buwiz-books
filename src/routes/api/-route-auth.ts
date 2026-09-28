import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth";
import { getActiveOrganizationId } from "@/lib/auth-types";

export interface RouteAuthState {
  userId: string | null;
  /**
   * The session's active organization, when one is set. For building links only (the retired
   * `/review-agents` maps old rule links onto that organization's Settings) — it is not an
   * authorization input: every server function still resolves the organization and role itself.
   */
  activeOrganizationId: string | null;
}

/**
 * Resolve the request's session before protected route components load.
 *
 * Only the user ID and the active organization ID — which the client's own session already
 * carries — cross the server-function boundary. Protected data remains guarded independently
 * inside each server function/API handler.
 */
export const getRouteAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<RouteAuthState> => {
    const request = getRequest();
    if (!request) return { userId: null, activeOrganizationId: null };

    const session = await auth.api.getSession({ headers: request.headers });
    return {
      userId: session?.user?.id ?? null,
      activeOrganizationId: session?.user ? getActiveOrganizationId(session) : null,
    };
  },
);
