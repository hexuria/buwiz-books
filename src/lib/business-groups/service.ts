import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { member, organization, user } from "../../db/schema/auth";
import {
  enterpriseAccountMembers,
  organizationGroupEntities,
  organizationGroupAuditEvents,
  organizationGroupMembers,
  organizationGroups,
  type BusinessGroupRole,
} from "../../db/schema/business-groups";
import { parseOrgMetadata } from "../org-metadata";
import {
  EnterpriseEntitlementLimitError,
  BusinessGroupAccessError,
  type EntitlementOperation,
} from "../enterprise/entitlement-state";
import {
  getBusinessGroupsEntityUsage,
  requireBusinessGroupsEntitlement,
  requireEnterpriseAccountRole,
} from "../enterprise/entitlements";

const GROUP_MANAGER_ROLES: readonly BusinessGroupRole[] = ["owner", "admin"];
const ENTERPRISE_GROUP_MANAGER_ROLES = ["owner", "group_admin"] as const;
const GROUP_STATUSES = ["active", "archived"] as const;
const GROUP_ROLE_RANK: Record<BusinessGroupRole, number> = {
  owner: 4,
  admin: 3,
  analyst: 2,
  viewer: 1,
};
type BusinessGroupStatus = (typeof GROUP_STATUSES)[number];

async function ensureGroupStatus(
  executor: DbExecutor,
  groupId: string,
  expectedStatus: BusinessGroupStatus,
): Promise<void> {
  const [group] = await executor
    .select({ status: organizationGroups.status })
    .from(organizationGroups)
    .where(eq(organizationGroups.id, groupId))
    .limit(1);
  if (group?.status !== expectedStatus) {
    throw new BusinessGroupAccessError("This Business Group is unavailable");
  }
}

async function listEligibleGroupOwners(executor: DbExecutor, groupId: string) {
  return executor
    .select({ id: organizationGroupMembers.id, userId: organizationGroupMembers.userId })
    .from(organizationGroupMembers)
    .innerJoin(organizationGroups, eq(organizationGroups.id, organizationGroupMembers.groupId))
    .innerJoin(
      enterpriseAccountMembers,
      and(
        eq(enterpriseAccountMembers.enterpriseAccountId, organizationGroups.enterpriseAccountId),
        eq(enterpriseAccountMembers.userId, organizationGroupMembers.userId),
        inArray(enterpriseAccountMembers.role, ["owner", "group_admin"]),
      ),
    )
    .where(
      and(
        eq(organizationGroupMembers.groupId, groupId),
        eq(organizationGroupMembers.role, "owner"),
      ),
    )
    .limit(2);
}

export interface BusinessGroupView {
  id: string;
  enterpriseAccountId: string;
  name: string;
  status: string;
  reportingTimezone: string;
  defaultReportingCurrency: string;
  role: BusinessGroupRole;
  entityCount: number;
  updatedAt: Date;
}

export interface AccessibleGroupEntity {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  currency: string;
}

export interface GroupEntityAccessView {
  entities: AccessibleGroupEntity[];
  totalEntityCount: number;
  omittedEntityCount: number;
  isComplete: boolean;
}

export interface AccessibleBusinessGroupView {
  enterpriseAccountId: string;
  groupId: string;
  groupName: string;
  access: GroupEntityAccessView;
}

export async function listBusinessGroups(
  executor: DbExecutor,
  userId: string,
  enterpriseAccountId?: string,
): Promise<BusinessGroupView[]> {
  const conditions = [eq(organizationGroupMembers.userId, userId)];
  if (enterpriseAccountId) {
    conditions.push(eq(organizationGroups.enterpriseAccountId, enterpriseAccountId));
  }

  const rows = await executor
    .select({
      group: organizationGroups,
      role: organizationGroupMembers.role,
      entityCount: sql<number>`(
        select count(*)::int
        from ${organizationGroupEntities} entities
        where entities.group_id = ${organizationGroups.id}
          and entities.status = 'enabled'
      )`,
    })
    .from(organizationGroupMembers)
    .innerJoin(organizationGroups, eq(organizationGroupMembers.groupId, organizationGroups.id))
    .where(and(...conditions))
    .orderBy(asc(organizationGroups.name));

  return rows.map(({ group, role, entityCount }) => ({
    id: group.id,
    enterpriseAccountId: group.enterpriseAccountId,
    name: group.name,
    status: group.status,
    reportingTimezone: group.reportingTimezone,
    defaultReportingCurrency: group.defaultReportingCurrency,
    role,
    entityCount: Number(entityCount),
    updatedAt: group.updatedAt,
  }));
}

async function requireGroupIdentity(
  executor: DbExecutor,
  groupId: string,
  userId: string,
  allowedRoles?: readonly BusinessGroupRole[],
  allowedStatuses: readonly BusinessGroupStatus[] = ["active"],
  requireEnterpriseManager = false,
) {
  const [row] = await executor
    .select({
      group: organizationGroups,
      membership: organizationGroupMembers,
      accountMembership: enterpriseAccountMembers,
    })
    .from(organizationGroups)
    .innerJoin(
      organizationGroupMembers,
      and(
        eq(organizationGroupMembers.groupId, organizationGroups.id),
        eq(organizationGroupMembers.userId, userId),
      ),
    )
    .innerJoin(
      enterpriseAccountMembers,
      and(
        eq(enterpriseAccountMembers.enterpriseAccountId, organizationGroups.enterpriseAccountId),
        eq(enterpriseAccountMembers.userId, userId),
      ),
    )
    .where(eq(organizationGroups.id, groupId))
    .limit(1);

  if (!row || !allowedStatuses.includes(row.group.status as BusinessGroupStatus)) {
    throw new BusinessGroupAccessError();
  }
  if (allowedRoles && !allowedRoles.includes(row.membership.role)) {
    throw new BusinessGroupAccessError("This Business Group role cannot perform that action");
  }
  if (
    requireEnterpriseManager &&
    !ENTERPRISE_GROUP_MANAGER_ROLES.some((role) => role === row.accountMembership.role)
  ) {
    throw new BusinessGroupAccessError(
      "Enterprise owner or group-admin access is required for this action",
    );
  }

  return row;
}

async function requireGroupMembership(
  executor: DbExecutor,
  groupId: string,
  userId: string,
  operation: EntitlementOperation,
  allowedRoles?: readonly BusinessGroupRole[],
  allowedStatuses: readonly BusinessGroupStatus[] = ["active"],
) {
  const row = await requireGroupIdentity(
    executor,
    groupId,
    userId,
    allowedRoles,
    allowedStatuses,
    operation === "mutate",
  );

  const entitlement = await requireBusinessGroupsEntitlement(
    executor,
    row.group.enterpriseAccountId,
    operation,
  );
  return { ...row, entitlement };
}

async function requireGroupReductionAccess(executor: DbExecutor, groupId: string, userId: string) {
  return requireGroupIdentity(executor, groupId, userId, GROUP_MANAGER_ROLES, GROUP_STATUSES, true);
}

export async function requireGroupAccess(
  executor: DbExecutor,
  groupId: string,
  userId: string,
  operation: EntitlementOperation,
  allowedRoles?: readonly BusinessGroupRole[],
) {
  return requireGroupMembership(executor, groupId, userId, operation, allowedRoles, ["active"]);
}

export async function createBusinessGroup(
  executor: DbExecutor,
  input: {
    enterpriseAccountId: string;
    userId: string;
    name: string;
    reportingTimezone: string;
    defaultReportingCurrency: string;
  },
): Promise<BusinessGroupView> {
  await requireEnterpriseAccountRole(executor, input.enterpriseAccountId, input.userId, [
    "owner",
    "group_admin",
  ]);
  await requireBusinessGroupsEntitlement(executor, input.enterpriseAccountId, "mutate");

  const [group] = await executor
    .insert(organizationGroups)
    .values({
      enterpriseAccountId: input.enterpriseAccountId,
      name: input.name.trim(),
      reportingTimezone: input.reportingTimezone,
      defaultReportingCurrency: input.defaultReportingCurrency.toUpperCase(),
      createdBy: input.userId,
    })
    .returning();

  await executor.insert(organizationGroupMembers).values({
    groupId: group.id,
    userId: input.userId,
    role: "owner",
  });

  return {
    id: group.id,
    enterpriseAccountId: group.enterpriseAccountId,
    name: group.name,
    status: group.status,
    reportingTimezone: group.reportingTimezone,
    defaultReportingCurrency: group.defaultReportingCurrency,
    role: "owner",
    entityCount: 0,
    updatedAt: group.updatedAt,
  };
}

export async function renameBusinessGroup(
  executor: DbExecutor,
  input: { groupId: string; userId: string; name: string },
): Promise<BusinessGroupView> {
  const access = await requireGroupAccess(
    executor,
    input.groupId,
    input.userId,
    "mutate",
    GROUP_MANAGER_ROLES,
  );
  const nextName = input.name.trim();
  if (nextName.length < 2 || nextName.length > 255) {
    throw new BusinessGroupAccessError("A Business Group name must contain 2 to 255 characters");
  }

  const [updated] = await executor
    .update(organizationGroups)
    .set({ name: nextName, updatedAt: new Date() })
    .where(and(eq(organizationGroups.id, input.groupId), eq(organizationGroups.status, "active")))
    .returning();
  if (!updated) throw new BusinessGroupAccessError("This Business Group is unavailable");

  const [entityCount] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationGroupEntities)
    .where(
      and(
        eq(organizationGroupEntities.groupId, input.groupId),
        eq(organizationGroupEntities.status, "enabled"),
      ),
    );
  return {
    id: updated.id,
    enterpriseAccountId: updated.enterpriseAccountId,
    name: updated.name,
    status: updated.status,
    reportingTimezone: updated.reportingTimezone,
    defaultReportingCurrency: updated.defaultReportingCurrency,
    role: access.membership.role,
    entityCount: Number(entityCount?.count ?? 0),
    updatedAt: updated.updatedAt,
  };
}

export async function archiveBusinessGroup(
  executor: DbExecutor,
  input: { groupId: string; userId: string },
): Promise<{ disabledEntityCount: number }> {
  await requireGroupAccess(executor, input.groupId, input.userId, "mutate", GROUP_MANAGER_ROLES);
  await ensureGroupStatus(executor, input.groupId, "active");
  const [archived] = await executor
    .update(organizationGroups)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(organizationGroups.id, input.groupId), eq(organizationGroups.status, "active")))
    .returning({ id: organizationGroups.id });
  if (!archived) throw new BusinessGroupAccessError("This Business Group is unavailable");

  const [archiveAudit] = await executor
    .select({ details: organizationGroupAuditEvents.details })
    .from(organizationGroupAuditEvents)
    .where(
      and(
        eq(organizationGroupAuditEvents.groupId, input.groupId),
        eq(organizationGroupAuditEvents.eventType, "group.archived"),
      ),
    )
    .orderBy(desc(organizationGroupAuditEvents.createdAt))
    .limit(1);
  const auditDetails = archiveAudit?.details as { disabledEntityCount?: number } | null | undefined;
  return { disabledEntityCount: Number(auditDetails?.disabledEntityCount ?? 0) };
}

export async function restoreBusinessGroup(
  executor: DbExecutor,
  input: { groupId: string; userId: string },
): Promise<void> {
  await requireGroupMembership(
    executor,
    input.groupId,
    input.userId,
    "mutate",
    GROUP_MANAGER_ROLES,
    ["archived"],
  );
  const [restored] = await executor
    .update(organizationGroups)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(organizationGroups.id, input.groupId), eq(organizationGroups.status, "archived")))
    .returning({ id: organizationGroups.id });
  if (!restored) throw new BusinessGroupAccessError("This Business Group is unavailable");
}

async function requireLinkableOrganization(
  executor: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  const [organizationMembership] = await executor
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);

  if (!organizationMembership || !["owner", "admin"].includes(organizationMembership.role)) {
    throw new BusinessGroupAccessError(
      "Only an owner or administrator of an organization can link it to a Business Group",
    );
  }
}

export async function addOrganizationToGroup(
  executor: DbExecutor,
  input: {
    groupId: string;
    organizationId: string;
    userId: string;
  },
): Promise<{ entityId: string; usage: number; limit: number }> {
  const access = await requireGroupAccess(
    executor,
    input.groupId,
    input.userId,
    "mutate",
    GROUP_MANAGER_ROLES,
  );
  await ensureGroupStatus(executor, input.groupId, "active");
  await requireLinkableOrganization(executor, input.organizationId, input.userId);

  const assignmentRows = await executor.execute(
    sql`select is_organization_assigned_to_business_group(
        ${access.group.enterpriseAccountId},
        ${input.organizationId},
        ${input.groupId},
        ${input.userId}
      ) as assigned_elsewhere`,
  );
  const assignment = assignmentRows[0] as { assigned_elsewhere: boolean } | undefined;
  if (assignment?.assigned_elsewhere) {
    throw new BusinessGroupAccessError(
      "This organization already belongs to another Business Group in this Enterprise account",
    );
  }

  const usageBefore = await getBusinessGroupsEntityUsage(
    executor,
    access.group.enterpriseAccountId,
  );
  if (usageBefore >= access.entitlement.includedEntityLimit) {
    throw new EnterpriseEntitlementLimitError(usageBefore, access.entitlement.includedEntityLimit);
  }

  const [existing] = await executor
    .select()
    .from(organizationGroupEntities)
    .where(
      and(
        eq(organizationGroupEntities.groupId, input.groupId),
        eq(organizationGroupEntities.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  let entityId: string;
  if (existing) {
    if (existing.status === "enabled") {
      throw new BusinessGroupAccessError("This organization is already linked to the group");
    }
    const [restored] = await executor
      .update(organizationGroupEntities)
      .set({
        enterpriseAccountId: access.group.enterpriseAccountId,
        status: "enabled",
        updatedAt: new Date(),
      })
      .where(eq(organizationGroupEntities.id, existing.id))
      .returning({ id: organizationGroupEntities.id });
    entityId = restored.id;
  } else {
    const [created] = await executor
      .insert(organizationGroupEntities)
      .values({
        enterpriseAccountId: access.group.enterpriseAccountId,
        groupId: input.groupId,
        organizationId: input.organizationId,
        createdBy: input.userId,
      })
      .returning({ id: organizationGroupEntities.id });
    entityId = created.id;
  }

  const usage = await getBusinessGroupsEntityUsage(executor, access.group.enterpriseAccountId);
  const currentEntitlement = await requireBusinessGroupsEntitlement(
    executor,
    access.group.enterpriseAccountId,
    "mutate",
  );
  return { entityId, usage, limit: currentEntitlement.includedEntityLimit };
}

export async function removeOrganizationFromGroup(
  executor: DbExecutor,
  input: { groupId: string; entityId: string; userId: string },
): Promise<void> {
  await requireGroupReductionAccess(executor, input.groupId, input.userId);
  const [entity] = await executor
    .select()
    .from(organizationGroupEntities)
    .where(
      and(
        eq(organizationGroupEntities.id, input.entityId),
        eq(organizationGroupEntities.groupId, input.groupId),
        eq(organizationGroupEntities.status, "enabled"),
      ),
    )
    .limit(1);
  if (!entity) throw new BusinessGroupAccessError("Entity is not active in this group");

  await executor
    .update(organizationGroupEntities)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(organizationGroupEntities.id, input.entityId));
}

export async function getAccessibleGroupEntities(
  executor: DbExecutor,
  groupId: string,
  userId: string,
  operation: EntitlementOperation = "read",
): Promise<GroupEntityAccessView> {
  await requireGroupAccess(executor, groupId, userId, operation);
  const allEntities = await executor
    .select({
      id: organizationGroupEntities.id,
      organizationId: organizationGroupEntities.organizationId,
      name: organization.name,
      metadata: organization.metadata,
    })
    .from(organizationGroupEntities)
    .innerJoin(organization, eq(organizationGroupEntities.organizationId, organization.id))
    .where(
      and(
        eq(organizationGroupEntities.groupId, groupId),
        eq(organizationGroupEntities.status, "enabled"),
      ),
    )
    .orderBy(asc(organization.name));

  if (allEntities.length === 0) {
    return { entities: [], totalEntityCount: 0, omittedEntityCount: 0, isComplete: true };
  }

  const memberships = await executor
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        inArray(
          member.organizationId,
          allEntities.map((entity) => entity.organizationId),
        ),
      ),
    );
  const roleByOrganization = new Map(
    memberships.map((membership) => [membership.organizationId, membership.role]),
  );
  const entities = allEntities
    .filter((entity) => roleByOrganization.has(entity.organizationId))
    .map((entity) => ({
      id: entity.id,
      organizationId: entity.organizationId,
      name: entity.name,
      role: roleByOrganization.get(entity.organizationId)!,
      currency: parseOrgMetadata(entity.metadata).currency ?? "USD",
    }));

  const omittedEntityCount = allEntities.length - entities.length;
  return {
    entities,
    totalEntityCount: allEntities.length,
    omittedEntityCount,
    isComplete: omittedEntityCount === 0,
  };
}

/**
 * Resolve several Business Groups in a bounded number of queries. Group and
 * Enterprise membership are checked together, the entitlement is resolved
 * once, and direct organization membership is loaded for the whole portfolio.
 */
export async function getAccessibleGroupEntitiesForGroups(
  executor: DbExecutor,
  groupIds: readonly string[],
  userId: string,
  operation: EntitlementOperation = "read",
): Promise<AccessibleBusinessGroupView[]> {
  const uniqueGroupIds = [...new Set(groupIds)];
  if (uniqueGroupIds.length === 0) return [];

  const groups = await executor
    .select({
      id: organizationGroups.id,
      name: organizationGroups.name,
      enterpriseAccountId: organizationGroups.enterpriseAccountId,
    })
    .from(organizationGroups)
    .innerJoin(
      organizationGroupMembers,
      and(
        eq(organizationGroupMembers.groupId, organizationGroups.id),
        eq(organizationGroupMembers.userId, userId),
      ),
    )
    .innerJoin(
      enterpriseAccountMembers,
      and(
        eq(enterpriseAccountMembers.enterpriseAccountId, organizationGroups.enterpriseAccountId),
        eq(enterpriseAccountMembers.userId, userId),
      ),
    )
    .where(
      and(inArray(organizationGroups.id, uniqueGroupIds), eq(organizationGroups.status, "active")),
    );

  if (groups.length !== uniqueGroupIds.length) {
    throw new BusinessGroupAccessError("One or more selected Business Groups are unavailable");
  }
  const accountIds = new Set(groups.map((group) => group.enterpriseAccountId));
  if (accountIds.size !== 1) {
    throw new BusinessGroupAccessError(
      "Selected Business Groups must belong to the same Enterprise account",
    );
  }
  await requireBusinessGroupsEntitlement(executor, groups[0].enterpriseAccountId, operation);

  const allEntities = await executor
    .select({
      id: organizationGroupEntities.id,
      groupId: organizationGroupEntities.groupId,
      organizationId: organizationGroupEntities.organizationId,
      name: organization.name,
      metadata: organization.metadata,
    })
    .from(organizationGroupEntities)
    .innerJoin(organization, eq(organizationGroupEntities.organizationId, organization.id))
    .where(
      and(
        inArray(organizationGroupEntities.groupId, uniqueGroupIds),
        eq(organizationGroupEntities.status, "enabled"),
      ),
    )
    .orderBy(asc(organization.name));

  const organizationIds = [...new Set(allEntities.map((entity) => entity.organizationId))];
  const memberships =
    organizationIds.length === 0
      ? []
      : await executor
          .select({ organizationId: member.organizationId, role: member.role })
          .from(member)
          .where(and(eq(member.userId, userId), inArray(member.organizationId, organizationIds)));
  const roleByOrganization = new Map(
    memberships.map((membership) => [membership.organizationId, membership.role]),
  );
  const entitiesByGroup = new Map<string, typeof allEntities>();
  for (const entity of allEntities) {
    const rows = entitiesByGroup.get(entity.groupId) ?? [];
    rows.push(entity);
    entitiesByGroup.set(entity.groupId, rows);
  }
  const groupById = new Map(groups.map((group) => [group.id, group]));

  return uniqueGroupIds.map((groupId) => {
    const group = groupById.get(groupId)!;
    const rows = entitiesByGroup.get(groupId) ?? [];
    const entities = rows
      .filter((entity) => roleByOrganization.has(entity.organizationId))
      .map((entity) => ({
        id: entity.id,
        organizationId: entity.organizationId,
        name: entity.name,
        role: roleByOrganization.get(entity.organizationId)!,
        currency: parseOrgMetadata(entity.metadata).currency ?? "USD",
      }));
    const omittedEntityCount = rows.length - entities.length;
    return {
      enterpriseAccountId: group.enterpriseAccountId,
      groupId,
      groupName: group.name,
      access: {
        entities,
        totalEntityCount: rows.length,
        omittedEntityCount,
        isComplete: omittedEntityCount === 0,
      },
    };
  });
}

export async function listLinkableOrganizations(
  executor: DbExecutor,
  groupId: string,
  userId: string,
) {
  const access = await requireGroupAccess(executor, groupId, userId, "read");
  const [organizations, linked] = await Promise.all([
    executor
      .select({
        id: organization.id,
        name: organization.name,
        metadata: organization.metadata,
        role: member.role,
        linkedElsewhere: sql<boolean>`is_organization_assigned_to_business_group(
          ${access.group.enterpriseAccountId},
          ${organization.id},
          ${groupId},
          ${userId}
        )`,
      })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .where(eq(member.userId, userId))
      .orderBy(asc(organization.name)),
    executor
      .select({ organizationId: organizationGroupEntities.organizationId })
      .from(organizationGroupEntities)
      .where(
        and(
          eq(organizationGroupEntities.groupId, groupId),
          eq(organizationGroupEntities.status, "enabled"),
        ),
      ),
  ]);
  const linkedIds = new Set(linked.map((row) => row.organizationId));
  return organizations.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    currency: parseOrgMetadata(row.metadata).currency ?? "USD",
    linked: linkedIds.has(row.id),
    linkedElsewhere: row.linkedElsewhere,
    canLink: ["owner", "admin"].includes(row.role) && !row.linkedElsewhere,
  }));
}

export async function addBusinessGroupMember(
  executor: DbExecutor,
  input: { groupId: string; actorUserId: string; targetUserId: string; role: BusinessGroupRole },
): Promise<void> {
  const access = await requireGroupReductionAccess(executor, input.groupId, input.actorUserId);

  const [existingMembership] = await executor
    .select({ id: organizationGroupMembers.id, role: organizationGroupMembers.role })
    .from(organizationGroupMembers)
    .where(
      and(
        eq(organizationGroupMembers.groupId, input.groupId),
        eq(organizationGroupMembers.userId, input.targetUserId),
      ),
    )
    .limit(1);
  const isAccessIncrease =
    !existingMembership || GROUP_ROLE_RANK[input.role] > GROUP_ROLE_RANK[existingMembership.role];

  const [accountMembership] = await executor
    .select({ id: enterpriseAccountMembers.id, role: enterpriseAccountMembers.role })
    .from(enterpriseAccountMembers)
    .where(
      and(
        eq(enterpriseAccountMembers.enterpriseAccountId, access.group.enterpriseAccountId),
        eq(enterpriseAccountMembers.userId, input.targetUserId),
      ),
    )
    .limit(1);

  if (isAccessIncrease) {
    await ensureGroupStatus(executor, input.groupId, "active");
    await requireBusinessGroupsEntitlement(executor, access.group.enterpriseAccountId, "mutate");
    if (!accountMembership) {
      throw new BusinessGroupAccessError(
        "A user must belong to the Enterprise account before joining a Business Group",
      );
    }
    if (
      input.role === "owner" &&
      !ENTERPRISE_GROUP_MANAGER_ROLES.some((role) => role === accountMembership.role)
    ) {
      throw new BusinessGroupAccessError(
        "A Business Group owner must be an Enterprise owner or group admin",
      );
    }
  }

  if (input.role === "owner" && access.membership.role !== "owner") {
    throw new BusinessGroupAccessError("Only a Business Group owner can grant the owner role");
  }
  if (existingMembership?.role === "owner" && access.membership.role !== "owner") {
    throw new BusinessGroupAccessError("Only a Business Group owner can change an owner's role");
  }
  if (
    existingMembership?.role === "owner" &&
    input.role !== "owner" &&
    accountMembership &&
    ENTERPRISE_GROUP_MANAGER_ROLES.some((role) => role === accountMembership.role)
  ) {
    const eligibleOwners = await listEligibleGroupOwners(executor, input.groupId);
    if (eligibleOwners.length === 1) {
      throw new BusinessGroupAccessError("A Business Group must keep at least one eligible owner");
    }
  }

  if (existingMembership) {
    await executor
      .update(organizationGroupMembers)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(organizationGroupMembers.id, existingMembership.id));
  } else {
    await executor.insert(organizationGroupMembers).values({
      groupId: input.groupId,
      userId: input.targetUserId,
      role: input.role,
    });
  }
}

export async function removeBusinessGroupMember(
  executor: DbExecutor,
  input: { groupId: string; actorUserId: string; targetUserId: string },
): Promise<void> {
  const access = await requireGroupReductionAccess(executor, input.groupId, input.actorUserId);

  const [target] = await executor
    .select({ id: organizationGroupMembers.id, role: organizationGroupMembers.role })
    .from(organizationGroupMembers)
    .where(
      and(
        eq(organizationGroupMembers.groupId, input.groupId),
        eq(organizationGroupMembers.userId, input.targetUserId),
      ),
    )
    .limit(1);
  if (!target) throw new BusinessGroupAccessError("This user is not a Business Group member");
  if (target.role === "owner" && access.membership.role !== "owner") {
    throw new BusinessGroupAccessError("Only a Business Group owner can remove an owner");
  }
  if (target.role === "owner") {
    const eligibleOwners = await listEligibleGroupOwners(executor, input.groupId);
    if (eligibleOwners.length === 1 && eligibleOwners[0]?.userId === input.targetUserId) {
      throw new BusinessGroupAccessError("A Business Group must keep at least one eligible owner");
    }
  }

  await executor.delete(organizationGroupMembers).where(eq(organizationGroupMembers.id, target.id));
}

export async function listBusinessGroupMembers(
  executor: DbExecutor,
  groupId: string,
  userId: string,
) {
  await requireGroupMembership(executor, groupId, userId, "read", undefined, GROUP_STATUSES);
  return executor
    .select({
      id: organizationGroupMembers.id,
      userId: organizationGroupMembers.userId,
      role: organizationGroupMembers.role,
      name: user.name,
      email: user.email,
      updatedAt: organizationGroupMembers.updatedAt,
    })
    .from(organizationGroupMembers)
    .innerJoin(user, eq(organizationGroupMembers.userId, user.id))
    .where(eq(organizationGroupMembers.groupId, groupId))
    .orderBy(asc(user.name));
}

export async function listBusinessGroupMemberCandidates(
  executor: DbExecutor,
  groupId: string,
  userId: string,
) {
  const access = await requireGroupMembership(
    executor,
    groupId,
    userId,
    "read",
    GROUP_MANAGER_ROLES,
    GROUP_STATUSES,
  );
  return executor
    .select({
      userId: enterpriseAccountMembers.userId,
      name: user.name,
      email: user.email,
      enterpriseRole: enterpriseAccountMembers.role,
      groupRole: organizationGroupMembers.role,
    })
    .from(enterpriseAccountMembers)
    .innerJoin(user, eq(enterpriseAccountMembers.userId, user.id))
    .leftJoin(
      organizationGroupMembers,
      and(
        eq(organizationGroupMembers.groupId, groupId),
        eq(organizationGroupMembers.userId, enterpriseAccountMembers.userId),
      ),
    )
    .where(eq(enterpriseAccountMembers.enterpriseAccountId, access.group.enterpriseAccountId))
    .orderBy(asc(user.name));
}
