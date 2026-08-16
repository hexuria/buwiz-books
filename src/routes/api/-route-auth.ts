import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth";

export interface RouteAuthState {
  userId: string | null;
}

/**
 * Resolve the request's session before protected route components load.
 *
 * Only the user ID crosses the server-function boundary. Protected data
 * remains guarded independently inside each server function/API handler.
 */
export const getRouteAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<RouteAuthState> => {
    const request = getRequest();
    if (!request) return { userId: null };

    const session = await auth.api.getSession({ headers: request.headers });
    return { userId: session?.user?.id ?? null };
  },
);
