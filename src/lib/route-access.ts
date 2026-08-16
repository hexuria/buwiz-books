const PUBLIC_ROUTE_ROOTS = ["/login", "/organizations/join", "/invoices/pay"] as const;

interface RouterRenderState {
  location: { pathname: string };
  matches: ReadonlyArray<{ pathname: string }>;
}

/**
 * Routes that can render without an authenticated application session.
 *
 * Match complete path segments so similarly named protected routes (for
 * example, `/login-history`) cannot accidentally bypass the route guard.
 */
export function isPublicRoutePath(pathname: string): boolean {
  return PUBLIC_ROUTE_ROOTS.some(
    (publicRoot) => pathname === publicRoot || pathname.startsWith(`${publicRoot}/`),
  );
}

/**
 * Return the pathname for the route tree that is currently rendered.
 *
 * During client navigation TanStack Router updates `location` before the next
 * route matches are committed. Layout decisions must follow the committed
 * matches or the new shell can wrap the previous route while it is loading.
 */
export function getRenderedRoutePathname(state: RouterRenderState): string {
  return state.matches[state.matches.length - 1]?.pathname ?? state.location.pathname;
}
