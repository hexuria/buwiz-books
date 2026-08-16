import { createAuthClient } from "better-auth/react";
import { organizationClient, emailOTPClient } from "better-auth/client/plugins";
import { ac, roles } from "./permissions";

/**
 * Better Auth Client Instance
 *
 * React-specific client with:
 * - useSession hook for auth state
 * - signIn/signOut methods
 * - Organization client plugin for RBAC
 */
export const authClient = createAuthClient({
  // Base URL is optional when client and server share the same domain
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.BETTER_AUTH_URL || "http://localhost:3000",

  plugins: [
    emailOTPClient(),
    organizationClient({
      ac,
      roles: {
        owner: roles.superuser,
        admin: roles.admin,
        member: roles.member,
        client_approver: roles.clientApprover,
        report_viewer: roles.reportViewer,
      },
    }),
  ],
});

// Export commonly used methods for convenience
export const { signIn, signOut, signUp, useSession, getSession, organization } = authClient;

// Account management exports
export const { listAccounts, linkSocial, unlinkAccount } = authClient;

// Type exports
export type Session = ReturnType<typeof useSession>["data"];
