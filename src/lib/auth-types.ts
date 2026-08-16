import type { Session } from "./auth-client";

export type UserRole = "owner" | "admin" | "member" | "client_approver" | "report_viewer";

export interface ActiveMember {
  role?: UserRole;
  organizationId?: string | null;
}

export type AppSession = Session & {
  activeMember?: ActiveMember | null;
};

export interface BetterAuthErrorShape {
  message?: string;
}

export interface BetterAuthDataResponse<T> {
  data?: T | null;
  error?: BetterAuthErrorShape | null;
}

export interface BetterAuthListResponse<T> {
  data?: T[] | null;
  error?: BetterAuthErrorShape | null;
}

export function asAppSession(session: Session | null | undefined): AppSession | null {
  return (session ?? null) as AppSession | null;
}

export function getActiveOrganizationId(session: Session | null | undefined): string | null {
  return asAppSession(session)?.session?.activeOrganizationId ?? null;
}

export function getActiveMemberRole(session: Session | null | undefined): UserRole | null {
  return asAppSession(session)?.activeMember?.role ?? null;
}

export function getResponseData<T>(
  response: BetterAuthDataResponse<T> | null | undefined,
): T | null {
  return response?.data ?? null;
}

export function getResponseList<T>(response: BetterAuthListResponse<T> | null | undefined): T[] {
  return response?.data ?? [];
}

export function getResponseErrorMessage(
  response: BetterAuthDataResponse<unknown> | BetterAuthListResponse<unknown> | null | undefined,
): string | null {
  return response?.error?.message ?? null;
}
