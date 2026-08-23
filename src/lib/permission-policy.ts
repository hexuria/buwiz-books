import { roles } from "./permissions";

const ROLE_MAP: Record<string, { statements: Record<string, readonly string[]> }> = {
  owner: roles.superuser,
  // Some auth flows surface the raw role string "superuser" (the statement
  // set owner maps to). Without its own key those callers resolved to NO
  // permissions and every check silently failed closed.
  superuser: roles.superuser,
  admin: roles.admin,
  member: roles.member,
  client_approver: roles.clientApprover,
  report_viewer: roles.reportViewer,
};

/** Evaluate the static role policy without importing auth or database runtime code. */
export function roleHasPermission(role: string, resource: string, action: string): boolean {
  const roleDefinition = ROLE_MAP[role];
  const allowed = roleDefinition?.statements[resource];
  return allowed?.includes(action) ?? false;
}
