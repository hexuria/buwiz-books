import { and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
  organizationGroupEntities,
  organizationGroups,
  type EnterpriseAccountRole,
} from "../../db/schema/business-groups";
import {
  BUSINESS_GROUPS_FEATURE,
  BusinessGroupAccessError,
  EnterpriseEntitlementReadOnlyError,
  EnterpriseEntitlementRequiredError,
  entitlementAllowsOperation,
  resolveEntitlementState,
  type EffectiveEntitlementState,
  type EntitlementOperation,
} from "./entitlement-state";

export interface BusinessGroupsEntitlementView {
  entitlementId: string;
  enterpriseAccountId: string;
  storedStatus: typeof accountEntitlements.$inferSelect.status;
  effectiveStatus: EffectiveEntitlementState["status"];
  isEntitled: boolean;
  isReadOnly: boolean;
  includedEntityLimit: number;
  startsAt: Date;
  endsAt: Date | null;
  graceEndsAt: Date | null;
  effectiveUntil: Date | null;
  version: number;
}

export interface EnterpriseAccountAccessView {
  id: string;
  name: string;
  role: EnterpriseAccountRole;
  entitlement: BusinessGroupsEntitlementView | null;
}

/** Serialize every operation that reads or changes an account's linked-business allowance. */
export async function lockEnterpriseAllowance(
  executor: DbExecutor,
  enterpriseAccountId: string,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`business-groups:${enterpriseAccountId}`}, 0))`,
  );
}

function toView(
  row: typeof accountEntitlements.$inferSelect,
  now = new Date(),
): BusinessGroupsEntitlementView {
  const effective = resolveEntitlementState(row, now);
  return {
    entitlementId: row.id,
    enterpriseAccountId: row.enterpriseAccountId,
    storedStatus: row.status,
    effectiveStatus: effective.status,
    isEntitled: effective.isEntitled,
    isReadOnly: effective.isReadOnly,
    includedEntityLimit: row.includedEntityLimit,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    graceEndsAt: effective.graceEndsAt,
    effectiveUntil: effective.effectiveUntil,
    version: row.version,
  };
}

export async function listEnterpriseAccountsForUser(
  executor: DbExecutor,
  userId: string,
  now = new Date(),
): Promise<EnterpriseAccountAccessView[]> {
  const rows = await executor
    .select({
      account: enterpriseAccounts,
      role: enterpriseAccountMembers.role,
      entitlement: accountEntitlements,
    })
    .from(enterpriseAccountMembers)
    .innerJoin(
      enterpriseAccounts,
      eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccounts.id),
    )
    .leftJoin(
      accountEntitlements,
      and(
        eq(accountEntitlements.enterpriseAccountId, enterpriseAccounts.id),
        eq(accountEntitlements.featureKey, BUSINESS_GROUPS_FEATURE),
      ),
    )
    .where(eq(enterpriseAccountMembers.userId, userId))
    .orderBy(enterpriseAccounts.name);

  return rows.map((row) => ({
    id: row.account.id,
    name: row.account.name,
    role: row.role,
    entitlement: row.entitlement ? toView(row.entitlement, now) : null,
  }));
}

export async function requireEnterpriseAccountRole(
  executor: DbExecutor,
  enterpriseAccountId: string,
  userId: string,
  allowedRoles?: readonly EnterpriseAccountRole[],
): Promise<typeof enterpriseAccountMembers.$inferSelect> {
  const [membership] = await executor
    .select()
    .from(enterpriseAccountMembers)
    .where(
      and(
        eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
        eq(enterpriseAccountMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!membership || (allowedRoles && !allowedRoles.includes(membership.role))) {
    throw new BusinessGroupAccessError("Enterprise account access is denied");
  }
  return membership;
}

export async function requireBusinessGroupsEntitlement(
  executor: DbExecutor,
  enterpriseAccountId: string,
  operation: EntitlementOperation,
  now = new Date(),
): Promise<BusinessGroupsEntitlementView> {
  const [entitlement] = await executor
    .select()
    .from(accountEntitlements)
    .where(
      and(
        eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId),
        eq(accountEntitlements.featureKey, BUSINESS_GROUPS_FEATURE),
      ),
    )
    .limit(1);

  if (!entitlement) throw new EnterpriseEntitlementRequiredError();

  const view = toView(entitlement, now);
  if (view.effectiveStatus === "grace" && operation === "mutate") {
    throw new EnterpriseEntitlementReadOnlyError();
  }
  if (!entitlementAllowsOperation({ status: view.effectiveStatus }, operation)) {
    throw new EnterpriseEntitlementRequiredError();
  }
  return view;
}

export async function getBusinessGroupsEntitlement(
  executor: DbExecutor,
  enterpriseAccountId: string,
  now = new Date(),
): Promise<BusinessGroupsEntitlementView | null> {
  const [row] = await executor
    .select()
    .from(accountEntitlements)
    .where(
      and(
        eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId),
        eq(accountEntitlements.featureKey, BUSINESS_GROUPS_FEATURE),
      ),
    )
    .limit(1);
  return row ? toView(row, now) : null;
}

/** Count distinct enabled organizations across every active group in an account. */
export async function getBusinessGroupsEntityUsage(
  executor: DbExecutor,
  enterpriseAccountId: string,
): Promise<number> {
  const [row] = await executor
    .select({
      count: sql<number>`count(distinct ${organizationGroupEntities.organizationId})::int`,
    })
    .from(organizationGroupEntities)
    .innerJoin(organizationGroups, eq(organizationGroupEntities.groupId, organizationGroups.id))
    .where(
      and(
        eq(organizationGroups.enterpriseAccountId, enterpriseAccountId),
        eq(organizationGroups.status, "active"),
        eq(organizationGroupEntities.status, "enabled"),
      ),
    );
  return Number(row?.count ?? 0);
}
