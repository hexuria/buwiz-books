import { authClient } from "./auth-client";
import type { Resource, Action } from "./permissions";

/**
 * Permission Hook for UI Components
 *
 * Provides synchronous permission checking for React components.
 * Uses the role stored in the current session.
 */

/**
 * Check if the current user has a specific permission.
 *
 * @example
 * ```tsx
 * function CreateJournalButton() {
 *   const { canAccess, isLoading } = usePermission("journal", "create");
 *
 *   if (isLoading) return <Spinner />;
 *   if (!canAccess) return null;
 *
 *   return <Button>Create Journal</Button>;
 * }
 * ```
 */
export function usePermission<R extends Resource>(
  resource: R,
  action: Action<R>,
): { canAccess: boolean; isLoading: boolean } {
  const { data: activeMemberRole, isPending } = authClient.useActiveMemberRole();

  if (isPending) {
    return { canAccess: false, isLoading: true };
  }

  const role = activeMemberRole?.role;

  if (!role) {
    return { canAccess: false, isLoading: false };
  }

  // Use synchronous role-based permission check
  const canAccess = authClient.organization.checkRolePermission({
    role: role as "owner" | "admin" | "member" | "client_approver" | "report_viewer",
    permissions: {
      [resource]: [action],
    },
  });

  return { canAccess, isLoading: false };
}

/**
 * Check if the current user has all of the specified permissions.
 *
 * @example
 * ```tsx
 * function AdminPanel() {
 *   const { canAccess } = usePermissions({
 *     account: ["create", "delete"],
 *     journal: ["post", "void"],
 *   });
 *
 *   if (!canAccess) return <AccessDenied />;
 *   return <AdminContent />;
 * }
 * ```
 */
export function usePermissions(permissions: Partial<{ [R in Resource]: Action<R>[] }>): {
  canAccess: boolean;
  isLoading: boolean;
} {
  const { data: activeMemberRole, isPending } = authClient.useActiveMemberRole();

  if (isPending) {
    return { canAccess: false, isLoading: true };
  }

  const role = activeMemberRole?.role;

  if (!role) {
    return { canAccess: false, isLoading: false };
  }

  const canAccess = authClient.organization.checkRolePermission({
    role: role as "owner" | "admin" | "member" | "client_approver" | "report_viewer",
    permissions,
  });

  return { canAccess, isLoading: false };
}

/**
 * Get the current user's role.
 */
export function useRole(): { role: string | null; isLoading: boolean } {
  const { data: activeMemberRole, isPending } = authClient.useActiveMemberRole();

  if (isPending) {
    return { role: null, isLoading: true };
  }

  return { role: activeMemberRole?.role ?? null, isLoading: false };
}

/**
 * Check if user is authenticated.
 */
export function useIsAuthenticated(): {
  isAuthenticated: boolean;
  isLoading: boolean;
} {
  const { data: session, isPending } = authClient.useSession();

  return {
    isAuthenticated: !!session?.user,
    isLoading: isPending,
  };
}
