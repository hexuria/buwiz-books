import { AuthError } from "../auth-errors";
import type { EntitlementStatus } from "../../db/schema/business-groups";

export const BUSINESS_GROUPS_FEATURE = "business_groups" as const;
export const DEFAULT_ENTITLEMENT_GRACE_DAYS = 30;

export type EntitlementOperation = "read" | "export" | "mutate" | "project";

export interface EntitlementLifecycleInput {
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  graceEndsAt: Date | null;
}

export interface EffectiveEntitlementState {
  status: EntitlementStatus;
  isEntitled: boolean;
  isReadOnly: boolean;
  effectiveUntil: Date | null;
  graceEndsAt: Date | null;
}

export function defaultGraceEnd(endsAt: Date): Date {
  return new Date(endsAt.getTime() + DEFAULT_ENTITLEMENT_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Resolve lifecycle state at request time. This makes expiration fail closed
 * even if a scheduled lifecycle maintenance job is delayed.
 */
export function resolveEntitlementState(
  entitlement: EntitlementLifecycleInput,
  now = new Date(),
): EffectiveEntitlementState {
  const graceEndsAt =
    entitlement.graceEndsAt ?? (entitlement.endsAt ? defaultGraceEnd(entitlement.endsAt) : null);

  if (entitlement.status === "locked") {
    return {
      status: "locked",
      isEntitled: false,
      isReadOnly: false,
      effectiveUntil: null,
      graceEndsAt,
    };
  }

  const contractEnded = entitlement.endsAt && entitlement.endsAt.getTime() <= now.getTime();
  const explicitlyGracefulCancellation =
    entitlement.status === "cancelled" && graceEndsAt && graceEndsAt.getTime() > now.getTime();

  if (entitlement.status === "cancelled" && !explicitlyGracefulCancellation) {
    return {
      status: "locked",
      isEntitled: false,
      isReadOnly: false,
      effectiveUntil: null,
      graceEndsAt,
    };
  }

  if (entitlement.startsAt.getTime() > now.getTime()) {
    return {
      status: "pending",
      isEntitled: false,
      isReadOnly: false,
      effectiveUntil: entitlement.startsAt,
      graceEndsAt,
    };
  }

  if (
    entitlement.status === "grace" ||
    explicitlyGracefulCancellation ||
    ((entitlement.status === "active" || entitlement.status === "pending") && contractEnded)
  ) {
    if (graceEndsAt && graceEndsAt.getTime() > now.getTime()) {
      return {
        status: "grace",
        isEntitled: true,
        isReadOnly: true,
        effectiveUntil: graceEndsAt,
        graceEndsAt,
      };
    }
    return {
      status: "locked",
      isEntitled: false,
      isReadOnly: false,
      effectiveUntil: null,
      graceEndsAt,
    };
  }

  return {
    status: "active",
    isEntitled: true,
    isReadOnly: false,
    effectiveUntil: entitlement.endsAt,
    graceEndsAt,
  };
}

export function entitlementAllowsOperation(
  state: Pick<EffectiveEntitlementState, "status">,
  operation: EntitlementOperation,
): boolean {
  if (state.status === "active") return true;
  if (state.status !== "grace") return false;
  return operation === "read" || operation === "export" || operation === "project";
}

export class EnterpriseEntitlementRequiredError extends AuthError {
  constructor(message = "Business Groups requires an active Enterprise entitlement") {
    super(message, "ENTERPRISE_ENTITLEMENT_REQUIRED", 403);
    this.name = "EnterpriseEntitlementRequiredError";
  }
}

export class EnterpriseEntitlementReadOnlyError extends AuthError {
  constructor(message = "Business Groups is read-only during the Enterprise grace period") {
    super(message, "ENTERPRISE_ENTITLEMENT_READ_ONLY", 403);
    this.name = "EnterpriseEntitlementReadOnlyError";
  }
}

export class EnterpriseEntitlementLimitError extends AuthError {
  readonly usage: number;
  readonly limit: number;

  constructor(usage: number, limit: number) {
    super(
      `The Enterprise linked-entity allowance is ${limit}; current usage is ${usage}`,
      "ENTITLEMENT_LIMIT_EXCEEDED",
      409,
    );
    this.name = "EnterpriseEntitlementLimitError";
    this.usage = usage;
    this.limit = limit;
  }
}

export class BusinessGroupAccessError extends AuthError {
  constructor(message = "Access to this Business Group is denied") {
    super(message, "BUSINESS_GROUP_ACCESS_DENIED", 403);
    this.name = "BusinessGroupAccessError";
  }
}
