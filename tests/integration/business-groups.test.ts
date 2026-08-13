import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { createTestDb } from "../utils/db-utils";
import { member, organization, user } from "../../src/db/schema/auth";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
  organizationGroupEntities,
  organizationGroupAuditEvents,
  organizationGroupMembers,
  organizationGroups,
} from "../../src/db/schema/business-groups";
import {
  addBusinessGroupMember,
  addOrganizationToGroup,
  archiveBusinessGroup,
  createBusinessGroup,
  getAccessibleGroupEntities,
  getAccessibleGroupEntitiesForGroups,
  listBusinessGroupMemberCandidates,
  listBusinessGroupMembers,
  listBusinessGroups,
  listLinkableOrganizations,
  removeBusinessGroupMember,
  removeOrganizationFromGroup,
  renameBusinessGroup,
  restoreBusinessGroup,
} from "../../src/lib/business-groups/service";
import {
  BusinessGroupAccessError,
  EnterpriseEntitlementLimitError,
  EnterpriseEntitlementReadOnlyError,
} from "../../src/lib/enterprise/entitlement-state";
import { getBusinessGroupsEntityUsage } from "../../src/lib/enterprise/entitlements";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function expectDatabaseError(operation: () => Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  const messages: string[] = [];
  let cursor = error;
  while (cursor instanceof Error) {
    messages.push(cursor.message);
    cursor = cursor.cause;
  }
  expect(messages.join("\n")).toContain(expected);
}

async function expectDatabaseCode(operation: () => Promise<unknown>, expectedCode: string) {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  const codes: string[] = [];
  let cursor: unknown = error;
  while (cursor && typeof cursor === "object") {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") codes.push(candidate.code);
    cursor = candidate.cause;
  }
  expect(codes).toContain(expectedCode);
}

async function waitForBackendBlock(
  observer: Awaited<ReturnType<typeof createTestDb>>["sql"],
  backendPid: number,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [state] = await observer`
      SELECT cardinality(pg_blocking_pids(${backendPid})) > 0 AS blocked
    `;
    if (state?.blocked) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Backend ${backendPid} did not become blocked before the test deadline`);
}

describeDb("Enterprise Business Groups", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sqlClient: Awaited<ReturnType<typeof createTestDb>>["sql"];
  let ownerUserId: string;
  let limitedUserId: string;
  let billingUserId: string;
  let outsiderUserId: string;
  let enterpriseAccountId: string;
  let orgA: string;
  let orgB: string;
  let orgC: string;
  let unmanagedOrg: string;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  beforeEach(async () => {
    const suffix = crypto.randomUUID();
    ownerUserId = `bg-owner-${suffix}`;
    limitedUserId = `bg-limited-${suffix}`;
    billingUserId = `bg-billing-${suffix}`;
    outsiderUserId = `bg-outsider-${suffix}`;
    orgA = `bg-org-a-${suffix}`;
    orgB = `bg-org-b-${suffix}`;
    orgC = `bg-org-c-${suffix}`;
    unmanagedOrg = `bg-org-unmanaged-${suffix}`;

    await db.insert(user).values([
      {
        id: ownerUserId,
        name: "Enterprise Owner",
        email: `bg-owner-${suffix}@test.local`,
        emailVerified: true,
      },
      {
        id: limitedUserId,
        name: "Limited Analyst",
        email: `bg-limited-${suffix}@test.local`,
        emailVerified: true,
      },
      {
        id: billingUserId,
        name: "Billing Administrator",
        email: `bg-billing-${suffix}@test.local`,
        emailVerified: true,
      },
      {
        id: outsiderUserId,
        name: "Enterprise Outsider",
        email: `bg-outsider-${suffix}@test.local`,
        emailVerified: true,
      },
    ]);
    await db.insert(organization).values([
      {
        id: orgA,
        name: "Northwind Manufacturing",
        slug: `northwind-${suffix}`,
        metadata: JSON.stringify({ currency: "USD" }),
      },
      {
        id: orgB,
        name: "Harborline Logistics",
        slug: `harborline-${suffix}`,
        metadata: JSON.stringify({ currency: "USD" }),
      },
      {
        id: orgC,
        name: "Fieldstone Retail",
        slug: `fieldstone-${suffix}`,
        metadata: JSON.stringify({ currency: "USD" }),
      },
      {
        id: unmanagedOrg,
        name: "Unmanaged Subsidiary",
        slug: `unmanaged-${suffix}`,
        metadata: JSON.stringify({ currency: "USD" }),
      },
    ]);
    await db.insert(member).values([
      {
        id: `bg-member-a-${suffix}`,
        userId: ownerUserId,
        organizationId: orgA,
        role: "owner",
      },
      {
        id: `bg-member-b-${suffix}`,
        userId: ownerUserId,
        organizationId: orgB,
        role: "admin",
      },
      {
        id: `bg-member-c-${suffix}`,
        userId: ownerUserId,
        organizationId: orgC,
        role: "owner",
      },
      {
        id: `bg-limited-member-a-${suffix}`,
        userId: limitedUserId,
        organizationId: orgA,
        role: "member",
      },
    ]);
    const [account] = await db
      .insert(enterpriseAccounts)
      .values({ name: "Ironwood Holdings", createdBy: ownerUserId })
      .returning({ id: enterpriseAccounts.id });
    enterpriseAccountId = account.id;
    await db.insert(enterpriseAccountMembers).values([
      { enterpriseAccountId, userId: ownerUserId, role: "owner" },
      { enterpriseAccountId, userId: limitedUserId, role: "group_admin" },
      { enterpriseAccountId, userId: billingUserId, role: "billing_admin" },
    ]);
    await db.insert(accountEntitlements).values({
      enterpriseAccountId,
      featureKey: "business_groups",
      status: "active",
      includedEntityLimit: 2,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2030-01-01T00:00:00.000Z"),
      graceEndsAt: new Date("2030-01-31T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await db.delete(enterpriseAccounts).where(eq(enterpriseAccounts.id, enterpriseAccountId));
    await db.delete(organization).where(eq(organization.id, orgA));
    await db.delete(organization).where(eq(organization.id, orgB));
    await db.delete(organization).where(eq(organization.id, orgC));
    await db.delete(organization).where(eq(organization.id, unmanagedOrg));
    await db.delete(user).where(eq(user.id, ownerUserId));
    await db.delete(user).where(eq(user.id, limitedUserId));
    await db.delete(user).where(eq(user.id, billingUserId));
    await db.delete(user).where(eq(user.id, outsiderUserId));
  });

  async function createGroup(name = "Ironwood Portfolio") {
    return db.transaction((tx) =>
      createBusinessGroup(tx, {
        enterpriseAccountId,
        userId: ownerUserId,
        name,
        reportingTimezone: "America/New_York",
        defaultReportingCurrency: "USD",
      }),
    );
  }

  async function link(groupId: string, organizationId: string) {
    return db.transaction((tx) =>
      addOrganizationToGroup(tx, {
        groupId,
        organizationId,
        userId: ownerUserId,
      }),
    );
  }

  async function asRuntimeUser<T>(userId: string, operation: (tx: any) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      return operation(tx);
    });
  }

  it("enforces the linked-entity allowance and exclusive group assignment", async () => {
    const first = await createGroup();
    const second = await createGroup("Regional Comparison");
    await link(first.id, orgA);
    await link(first.id, orgB);

    expect(await getBusinessGroupsEntityUsage(db, enterpriseAccountId)).toBe(2);
    await expect(link(first.id, orgC)).rejects.toBeInstanceOf(EnterpriseEntitlementLimitError);

    await expect(link(second.id, orgA)).rejects.toThrow(
      "already belongs to another Business Group",
    );
    expect(await getBusinessGroupsEntityUsage(db, enterpriseAccountId)).toBe(2);

    const linkable = await listLinkableOrganizations(db, second.id, ownerUserId);
    expect(linkable.find((candidate) => candidate.id === orgA)).toMatchObject({
      linked: false,
      linkedElsewhere: true,
      canLink: false,
    });

    await expect(
      db.insert(organizationGroupEntities).values({
        enterpriseAccountId,
        groupId: second.id,
        organizationId: orgA,
        createdBy: ownerUserId,
      }),
    ).rejects.toThrow();
  });

  it("requires direct subsidiary membership and reports omitted entities without leaking them", async () => {
    const group = await createGroup();
    await link(group.id, orgA);
    await link(group.id, orgB);
    await db.insert(organizationGroupMembers).values({
      groupId: group.id,
      userId: limitedUserId,
      role: "analyst",
    });

    const view = await getAccessibleGroupEntities(db, group.id, limitedUserId);
    expect(view.totalEntityCount).toBe(2);
    expect(view.omittedEntityCount).toBe(1);
    expect(view.isComplete).toBe(false);
    expect(view.entities).toHaveLength(1);
    expect(view.entities[0].organizationId).toBe(orgA);
    expect(JSON.stringify(view)).not.toContain(orgB);
    expect(JSON.stringify(view)).not.toContain("Harborline Logistics");
  });

  it("loads several selected groups through one portfolio access operation", async () => {
    const first = await createGroup();
    const second = await createGroup("Regional Comparison");
    await link(first.id, orgA);
    await link(second.id, orgB);

    const views = await getAccessibleGroupEntitiesForGroups(db, [second.id, first.id], ownerUserId);

    expect(views.map((view) => view.groupId)).toEqual([second.id, first.id]);
    expect(views.map((view) => view.enterpriseAccountId)).toEqual([
      enterpriseAccountId,
      enterpriseAccountId,
    ]);
    expect(views[0].access.entities[0].organizationId).toBe(orgB);
    expect(views[1].access.entities[0].organizationId).toBe(orgA);
  });

  it("rejects a portfolio selection that crosses Enterprise account boundaries", async () => {
    const first = await createGroup();
    const [otherAccount] = await db
      .insert(enterpriseAccounts)
      .values({ name: "Separate Holdings", createdBy: ownerUserId })
      .returning({ id: enterpriseAccounts.id });

    try {
      await db.insert(enterpriseAccountMembers).values({
        enterpriseAccountId: otherAccount.id,
        userId: ownerUserId,
        role: "owner",
      });
      await db.insert(accountEntitlements).values({
        enterpriseAccountId: otherAccount.id,
        featureKey: "business_groups",
        status: "active",
        includedEntityLimit: 2,
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      const otherGroup = await db.transaction((tx) =>
        createBusinessGroup(tx, {
          enterpriseAccountId: otherAccount.id,
          userId: ownerUserId,
          name: "Separate Portfolio",
          reportingTimezone: "UTC",
          defaultReportingCurrency: "USD",
        }),
      );

      await expect(
        getAccessibleGroupEntitiesForGroups(db, [first.id, otherGroup.id], ownerUserId),
      ).rejects.toThrow("must belong to the same Enterprise account");
    } finally {
      await db.delete(enterpriseAccounts).where(eq(enterpriseAccounts.id, otherAccount.id));
    }
  });

  it("requires group membership cleanup before Enterprise access is removed", async () => {
    const group = await createGroup();
    await db.insert(organizationGroupMembers).values({
      groupId: group.id,
      userId: limitedUserId,
      role: "viewer",
    });
    await expectDatabaseError(
      () =>
        db
          .delete(enterpriseAccountMembers)
          .where(eq(enterpriseAccountMembers.userId, limitedUserId)),
      "Remove Business Group memberships",
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .delete(organizationGroupMembers)
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        ),
    );
    await db
      .delete(enterpriseAccountMembers)
      .where(eq(enterpriseAccountMembers.userId, limitedUserId));

    await expect(getAccessibleGroupEntities(db, group.id, limitedUserId)).rejects.toBeInstanceOf(
      BusinessGroupAccessError,
    );
  });

  it("allows reads but denies every group mutation during grace", async () => {
    const group = await createGroup();
    await db
      .update(accountEntitlements)
      .set({
        status: "grace",
        endsAt: new Date("2026-07-01T00:00:00.000Z"),
        graceEndsAt: new Date("2030-01-31T00:00:00.000Z"),
      })
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));

    const view = await getAccessibleGroupEntities(db, group.id, ownerUserId);
    expect(view.entities).toHaveLength(0);
    await expect(link(group.id, orgA)).rejects.toBeInstanceOf(EnterpriseEntitlementReadOnlyError);
  });

  it("permits membership and assignment access reduction after entitlement revocation", async () => {
    const group = await createGroup("Revocation cleanup group");
    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "admin",
      }),
    );
    const assignment = await link(group.id, orgA);
    await db
      .update(accountEntitlements)
      .set({ status: "locked" })
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));

    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "viewer",
      }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      removeOrganizationFromGroup(tx, {
        groupId: group.id,
        entityId: assignment.entityId,
        userId: ownerUserId,
      }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      removeBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
      }),
    );

    await expect(
      asRuntimeUser(ownerUserId, (tx) =>
        addBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: ownerUserId,
          targetUserId: limitedUserId,
          role: "viewer",
        }),
      ),
    ).rejects.toThrow();
    await expect(link(group.id, orgA)).rejects.toThrow();
  });

  it("permits only access reduction inside an archived group", async () => {
    const group = await createGroup("Archived access cleanup group");
    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "admin",
      }),
    );
    const assignment = await link(group.id, orgA);
    await asRuntimeUser(ownerUserId, (tx) =>
      archiveBusinessGroup(tx, { groupId: group.id, userId: ownerUserId }),
    );

    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "viewer",
      }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      removeBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
      }),
    );

    await sqlClient.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica");
      await tx`
        UPDATE organization_group_entities
        SET status = 'enabled'
        WHERE id = ${assignment.entityId}
      `;
      await tx.unsafe("SET LOCAL session_replication_role = origin");
    });
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupEntities)
        .set({ status: "disabled" })
        .where(eq(organizationGroupEntities.id, assignment.entityId)),
    );

    await expect(
      asRuntimeUser(ownerUserId, (tx) =>
        addBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: ownerUserId,
          targetUserId: limitedUserId,
          role: "viewer",
        }),
      ),
    ).rejects.toThrow("unavailable");
  });

  it("treats a started pending entitlement as active at the database boundary", async () => {
    await db
      .update(accountEntitlements)
      .set({ status: "pending" })
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));

    const group = await asRuntimeUser(ownerUserId, (tx) =>
      createBusinessGroup(tx, {
        enterpriseAccountId,
        userId: ownerUserId,
        name: "Started pending entitlement group",
        reportingTimezone: "UTC",
        defaultReportingCurrency: "USD",
      }),
    );
    const linked = await asRuntimeUser(ownerUserId, (tx) =>
      addOrganizationToGroup(tx, {
        groupId: group.id,
        organizationId: orgA,
        userId: ownerUserId,
      }),
    );

    expect(linked.usage).toBe(1);
  });

  it("keeps a started pending contract aligned across end, grace, and SQL mutation gates", async () => {
    const group = await createGroup("Pending lifecycle parity group");
    const now = Date.now();
    await db
      .update(accountEntitlements)
      .set({
        status: "pending",
        startsAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
        endsAt: new Date(now - 24 * 60 * 60 * 1000),
        graceEndsAt: new Date(now + 24 * 60 * 60 * 1000),
      })
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));

    await expect(getAccessibleGroupEntities(db, group.id, ownerUserId)).resolves.toMatchObject({
      entities: [],
    });
    const [duringGrace] = await sqlClient`
      SELECT has_active_business_groups_entitlement(${enterpriseAccountId}::uuid) AS active
    `;
    expect(duringGrace.active).toBe(false);
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ name: "Pending mutation must stay blocked" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "configuration changes require an active Enterprise entitlement",
    );

    await db
      .update(accountEntitlements)
      .set({ graceEndsAt: new Date(now - 1) })
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));
    await expect(getAccessibleGroupEntities(db, group.id, ownerUserId)).rejects.toThrow();
  });

  it.each(["grace", "locked"] as const)(
    "denies direct runtime configuration writes while the entitlement is %s",
    async (status) => {
      const activeGroup = await createGroup(`Direct ${status} active group`);
      const archivedGroup = await createGroup(`Direct ${status} archived group`);
      await asRuntimeUser(ownerUserId, (tx) =>
        tx
          .update(organizationGroups)
          .set({ status: "archived" })
          .where(eq(organizationGroups.id, archivedGroup.id)),
      );
      await db
        .update(accountEntitlements)
        .set({ status })
        .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));

      await expectDatabaseError(
        () =>
          asRuntimeUser(ownerUserId, (tx) =>
            tx
              .update(organizationGroups)
              .set({ name: `Blocked ${status} rename` })
              .where(eq(organizationGroups.id, activeGroup.id)),
          ),
        "configuration changes require an active Enterprise entitlement",
      );
      await expectDatabaseError(
        () =>
          asRuntimeUser(ownerUserId, (tx) =>
            tx
              .update(organizationGroups)
              .set({ status: "archived" })
              .where(eq(organizationGroups.id, activeGroup.id)),
          ),
        "configuration changes require an active Enterprise entitlement",
      );
      await expectDatabaseError(
        () =>
          asRuntimeUser(ownerUserId, (tx) =>
            tx
              .update(organizationGroups)
              .set({ status: "active" })
              .where(eq(organizationGroups.id, archivedGroup.id)),
          ),
        "configuration changes require an active Enterprise entitlement",
      );
      await expectDatabaseError(
        () =>
          asRuntimeUser(ownerUserId, (tx) =>
            tx.insert(organizationGroups).values({
              enterpriseAccountId,
              name: `Blocked ${status} group creation`,
              reportingTimezone: "UTC",
              defaultReportingCurrency: "USD",
              createdBy: ownerUserId,
            }),
          ),
        "configuration changes require an active Enterprise entitlement",
      );
      await expectDatabaseError(
        () =>
          asRuntimeUser(ownerUserId, (tx) =>
            tx.insert(organizationGroupMembers).values({
              groupId: activeGroup.id,
              userId: limitedUserId,
              role: "viewer",
            }),
          ),
        "membership changes require an active Enterprise entitlement",
      );
      await expectDatabaseError(
        () =>
          asRuntimeUser(ownerUserId, (tx) =>
            tx.insert(organizationGroupEntities).values({
              enterpriseAccountId,
              groupId: activeGroup.id,
              organizationId: orgA,
              createdBy: ownerUserId,
            }),
          ),
        "assignment changes require an active Enterprise entitlement",
      );
    },
  );

  it("prevents group admins from granting ownership and keeps a final owner", async () => {
    const group = await createGroup();
    await db.insert(organizationGroupMembers).values({
      groupId: group.id,
      userId: limitedUserId,
      role: "admin",
    });

    await expect(
      db.transaction((tx) =>
        addBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: limitedUserId,
          targetUserId: limitedUserId,
          role: "owner",
        }),
      ),
    ).rejects.toBeInstanceOf(BusinessGroupAccessError);

    await expect(
      db.transaction((tx) =>
        addBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: ownerUserId,
          targetUserId: ownerUserId,
          role: "admin",
        }),
      ),
    ).rejects.toThrow("at least one eligible owner");
  });

  it("composes Enterprise and group roles and enforces owner invariants under the runtime role", async () => {
    const group = await createGroup();
    await db.insert(organizationGroupMembers).values({
      groupId: group.id,
      userId: limitedUserId,
      role: "admin",
    });

    const insertedBillingAdmin = await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .insert(organizationGroupMembers)
        .values({ groupId: group.id, userId: billingUserId, role: "admin" })
        .returning({ userId: organizationGroupMembers.userId }),
    );
    expect(insertedBillingAdmin).toEqual([{ userId: billingUserId }]);

    const updatedBillingAdmin = await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "viewer" })
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, billingUserId),
          ),
        )
        .returning({ role: organizationGroupMembers.role }),
    );
    expect(updatedBillingAdmin).toEqual([{ role: "viewer" }]);
    const removedBillingAdmin = await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .delete(organizationGroupMembers)
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, billingUserId),
          ),
        )
        .returning({ userId: organizationGroupMembers.userId }),
    );
    expect(removedBillingAdmin).toEqual([{ userId: billingUserId }]);
    await asRuntimeUser(limitedUserId, (tx) =>
      tx.insert(organizationGroupMembers).values({
        groupId: group.id,
        userId: billingUserId,
        role: "admin",
      }),
    );

    const billingGroupUpdate = await asRuntimeUser(billingUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ name: "Billing bypass" })
        .where(eq(organizationGroups.id, group.id))
        .returning({ id: organizationGroups.id }),
    );
    expect(billingGroupUpdate).toEqual([]);
    await expect(
      asRuntimeUser(billingUserId, (tx) =>
        renameBusinessGroup(tx, {
          groupId: group.id,
          userId: billingUserId,
          name: "Billing service bypass",
        }),
      ),
    ).rejects.toThrow("Enterprise owner or group-admin access is required");

    const allowedGroupUpdate = await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ name: "Composed role update" })
        .where(eq(organizationGroups.id, group.id))
        .returning({ name: organizationGroups.name }),
    );
    expect(allowedGroupUpdate).toEqual([{ name: "Composed role update" }]);

    await expect(
      asRuntimeUser(limitedUserId, (tx) =>
        tx
          .update(organizationGroupMembers)
          .set({ role: "owner" })
          .where(
            and(
              eq(organizationGroupMembers.groupId, group.id),
              eq(organizationGroupMembers.userId, limitedUserId),
            ),
          ),
      ),
    ).rejects.toThrow();
    const adminOwnerRemoval = await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .delete(organizationGroupMembers)
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, ownerUserId),
          ),
        )
        .returning({ id: organizationGroupMembers.id }),
    );
    expect(adminOwnerRemoval).toEqual([]);

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupMembers)
            .set({ role: "owner" })
            .where(
              and(
                eq(organizationGroupMembers.groupId, group.id),
                eq(organizationGroupMembers.userId, billingUserId),
              ),
            ),
        ),
      "Enterprise owner or group_admin",
    );
    await expect(
      db.transaction((tx) =>
        addBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: ownerUserId,
          targetUserId: billingUserId,
          role: "owner",
        }),
      ),
    ).rejects.toThrow("Enterprise owner or group admin");

    const promotedOwner = await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "owner" })
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        )
        .returning({ role: organizationGroupMembers.role }),
    );
    expect(promotedOwner).toEqual([{ role: "owner" }]);

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupMembers)
            .set({ userId: billingUserId })
            .where(
              and(
                eq(organizationGroupMembers.groupId, group.id),
                eq(organizationGroupMembers.userId, limitedUserId),
              ),
            ),
        ),
      "membership id, group_id, user_id, and created_at are immutable",
    );

    const ownerSelfDemotion = await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "viewer" })
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, ownerUserId),
          ),
        )
        .returning({ role: organizationGroupMembers.role }),
    );
    expect(ownerSelfDemotion).toEqual([{ role: "viewer" }]);
    await expectDatabaseError(
      () =>
        asRuntimeUser(limitedUserId, (tx) =>
          tx
            .update(organizationGroupMembers)
            .set({ role: "viewer" })
            .where(
              and(
                eq(organizationGroupMembers.groupId, group.id),
                eq(organizationGroupMembers.userId, limitedUserId),
              ),
            ),
        ),
      "at least one eligible owner",
    );

    await expectDatabaseError(
      () =>
        db
          .update(enterpriseAccountMembers)
          .set({ role: "billing_admin" })
          .where(
            and(
              eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
              eq(enterpriseAccountMembers.userId, limitedUserId),
            ),
          ),
      "owner roles before changing",
    );

    await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "owner" })
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, ownerUserId),
          ),
        ),
    );
    await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "viewer" })
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        ),
    );
    await db
      .update(enterpriseAccountMembers)
      .set({ role: "billing_admin" })
      .where(
        and(
          eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
          eq(enterpriseAccountMembers.userId, limitedUserId),
        ),
      );
    await expectDatabaseError(
      () =>
        db
          .update(organizationGroupMembers)
          .set({ role: "viewer" })
          .where(
            and(
              eq(organizationGroupMembers.groupId, group.id),
              eq(organizationGroupMembers.userId, ownerUserId),
            ),
          ),
      "at least one eligible owner",
    );
    await expectDatabaseError(
      () =>
        db
          .delete(enterpriseAccountMembers)
          .where(
            and(
              eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
              eq(enterpriseAccountMembers.userId, ownerUserId),
            ),
          ),
      "Remove Business Group memberships",
    );
  });

  it("makes direct runtime group lifecycle writes atomic, immutable, and audited", async () => {
    const group = await createGroup("Direct lifecycle group");
    await link(group.id, orgA);
    await asRuntimeUser(ownerUserId, (tx) =>
      tx.insert(organizationGroupMembers).values({
        groupId: group.id,
        userId: limitedUserId,
        role: "viewer",
      }),
    );

    const [initial] = await db
      .select({ updatedAt: organizationGroups.updatedAt })
      .from(organizationGroups)
      .where(eq(organizationGroups.id, group.id));
    const spoofedTimestamp = await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ updatedAt: new Date("2000-01-01T00:00:00.000Z") })
        .where(eq(organizationGroups.id, group.id))
        .returning({ updatedAt: organizationGroups.updatedAt }),
    );
    expect(spoofedTimestamp).toEqual([{ updatedAt: initial.updatedAt }]);

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ reportingTimezone: "Asia/Manila" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "reporting_timezone and default_reporting_currency are immutable",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ defaultReportingCurrency: "EUR" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "reporting_timezone and default_reporting_currency are immutable",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ name: "X" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "name must be trimmed and contain 2 to 255 characters",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ name: " Untrimmed group " })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "name must be trimmed and contain 2 to 255 characters",
    );

    const renamed = await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ name: "Directly renamed group" })
        .where(eq(organizationGroups.id, group.id))
        .returning({ name: organizationGroups.name }),
    );
    expect(renamed).toEqual([{ name: "Directly renamed group" }]);

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ name: "Combined archive rename", status: "archived" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "Rename and lifecycle status changes must be separate",
    );
    const [stillActiveAssignment] = await db
      .select({ status: organizationGroupEntities.status })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.groupId, group.id));
    expect(stillActiveAssignment?.status).toBe("enabled");

    const archived = await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ status: "archived" })
        .where(eq(organizationGroups.id, group.id))
        .returning({ status: organizationGroups.status }),
    );
    expect(archived).toEqual([{ status: "archived" }]);

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ name: "Archived rename attempt" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "archived Business Group is read-only",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ name: "Combined restore rename", status: "active" })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "Rename and lifecycle status changes must be separate",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroupMembers).values({
            groupId: group.id,
            userId: billingUserId,
            role: "viewer",
          }),
        ),
      "archived Business Group permits only membership access reduction",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupMembers)
            .set({ role: "analyst" })
            .where(
              and(
                eq(organizationGroupMembers.groupId, group.id),
                eq(organizationGroupMembers.userId, limitedUserId),
              ),
            ),
        ),
      "archived Business Group permits only membership access reduction",
    );
    const removedArchivedViewer = await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .delete(organizationGroupMembers)
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        )
        .returning({ userId: organizationGroupMembers.userId }),
    );
    expect(removedArchivedViewer).toEqual([{ userId: limitedUserId }]);
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroupEntities).values({
            enterpriseAccountId,
            groupId: group.id,
            organizationId: orgB,
            status: "disabled",
            createdBy: ownerUserId,
          }),
        ),
      "new Business Group assignment must be enabled",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupEntities)
            .set({ updatedAt: new Date() })
            .where(eq(organizationGroupEntities.groupId, group.id)),
        ),
      "archived Business Group permits only assignment access reduction",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .delete(organizationGroupEntities)
            .where(eq(organizationGroupEntities.groupId, group.id)),
        ),
      "Business Group assignments must be disabled instead of deleted",
    );
    const [assignment] = await db
      .select({ status: organizationGroupEntities.status })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.groupId, group.id));
    expect(assignment?.status).toBe("disabled");

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupEntities)
            .set({ status: "enabled" })
            .where(eq(organizationGroupEntities.groupId, group.id)),
        ),
      "archived Business Group cannot have enabled assignments",
    );

    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ status: "active" })
        .where(eq(organizationGroups.id, group.id)),
    );
    const [restoredAssignment] = await db
      .select({ status: organizationGroupEntities.status })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.groupId, group.id));
    expect(restoredAssignment?.status).toBe("disabled");

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroups)
            .set({ enterpriseAccountId: crypto.randomUUID() })
            .where(eq(organizationGroups.id, group.id)),
        ),
      "enterprise_account_id, created_by, and created_at are immutable",
    );

    const events = await db
      .select({
        eventType: organizationGroupAuditEvents.eventType,
        actorUserId: organizationGroupAuditEvents.actorUserId,
        details: organizationGroupAuditEvents.details,
      })
      .from(organizationGroupAuditEvents)
      .where(eq(organizationGroupAuditEvents.groupId, group.id));
    expect(events.filter((event) => event.eventType === "group.created")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "group.renamed")).toEqual([
      expect.objectContaining({
        actorUserId: ownerUserId,
        details: expect.objectContaining({
          previousName: "Direct lifecycle group",
          name: "Directly renamed group",
        }),
      }),
    ]);
    expect(events.filter((event) => event.eventType === "group.archived")).toEqual([
      expect.objectContaining({
        actorUserId: ownerUserId,
        details: expect.objectContaining({ disabledEntityCount: 1 }),
      }),
    ]);
    expect(events.filter((event) => event.eventType === "group.restored")).toHaveLength(1);
  });

  it("audits direct assignment lifecycle writes without archive-generated unlink noise", async () => {
    const group = await createGroup("Direct assignment audit group");
    const [assignment] = await asRuntimeUser<Array<{ id: string }>>(ownerUserId, (tx) =>
      tx
        .insert(organizationGroupEntities)
        .values({
          enterpriseAccountId,
          groupId: group.id,
          organizationId: orgA,
          createdBy: ownerUserId,
        })
        .returning({ id: organizationGroupEntities.id }),
    );

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupEntities)
            .set({ organizationId: orgB })
            .where(eq(organizationGroupEntities.id, assignment.id)),
        ),
      "assignment id, enterprise_account_id, group_id, organization_id, created_by, and created_at are immutable",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .delete(organizationGroupEntities)
            .where(eq(organizationGroupEntities.id, assignment.id)),
        ),
      "assignments must be disabled instead of deleted",
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupEntities)
        .set({ status: "disabled" })
        .where(eq(organizationGroupEntities.id, assignment.id)),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupEntities)
        .set({ status: "enabled" })
        .where(eq(organizationGroupEntities.id, assignment.id)),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ status: "archived" })
        .where(eq(organizationGroups.id, group.id)),
    );

    const assignmentEvents = await db
      .select({
        eventType: organizationGroupAuditEvents.eventType,
        actorUserId: organizationGroupAuditEvents.actorUserId,
        details: organizationGroupAuditEvents.details,
      })
      .from(organizationGroupAuditEvents)
      .where(
        and(
          eq(organizationGroupAuditEvents.groupId, group.id),
          eq(organizationGroupAuditEvents.subjectId, orgA),
        ),
      );
    expect(assignmentEvents).toHaveLength(3);
    expect(assignmentEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["entity.linked", "entity.unlinked", "entity.restored"]),
    );
    expect(assignmentEvents.filter((event) => event.eventType === "entity.unlinked")).toHaveLength(
      1,
    );
    expect(assignmentEvents.every((event) => event.actorUserId === ownerUserId)).toBe(true);
    expect(assignmentEvents.map((event) => event.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: assignment.id, usage: 0 }),
        expect.objectContaining({ entityId: assignment.id, usage: 1 }),
      ]),
    );

    const archiveEvents = await db
      .select({ details: organizationGroupAuditEvents.details })
      .from(organizationGroupAuditEvents)
      .where(
        and(
          eq(organizationGroupAuditEvents.groupId, group.id),
          eq(organizationGroupAuditEvents.eventType, "group.archived"),
        ),
      );
    expect(archiveEvents).toEqual([
      { details: expect.objectContaining({ disabledEntityCount: 1 }) },
    ]);
  });

  it("rejects a link after a demotion-first direct-organization role change", async () => {
    const group = await createGroup("Demotion-first organization link");
    const demoter = await createTestDb();
    const linker = await createTestDb();
    let releaseDemotion!: () => void;
    let reportDemotionReady!: () => void;
    let reportLinkerPid!: (pid: number) => void;
    const holdDemotion = new Promise<void>((resolveHold) => {
      releaseDemotion = resolveHold;
    });
    const demotionReady = new Promise<void>((resolveReady) => {
      reportDemotionReady = resolveReady;
    });
    const linkerPid = new Promise<number>((resolvePid) => {
      reportLinkerPid = resolvePid;
    });

    const demotion = demoter.sql.begin(async (tx) => {
      await tx`
        UPDATE auth_members
        SET role = 'member'
        WHERE organization_id = ${orgB}
          AND user_id = ${ownerUserId}
      `;
      reportDemotionReady();
      await holdDemotion;
    });

    let linkAttempt: Promise<unknown> | undefined;
    let checkedLink: Promise<void> | undefined;
    try {
      await demotionReady;
      linkAttempt = linker.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE buwiz_app`;
        await tx`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportLinkerPid(Number(backend.pid));
        await tx`
          INSERT INTO organization_group_entities (
            enterprise_account_id,
            group_id,
            organization_id,
            created_by
          ) VALUES (
            ${enterpriseAccountId}::uuid,
            ${group.id}::uuid,
            ${orgB},
            ${ownerUserId}
          )
        `;
      });
      checkedLink = expectDatabaseError(
        () => linkAttempt!,
        "current actor must be an owner or admin of the assigned organization",
      );
      await waitForBackendBlock(sqlClient, await linkerPid);
      releaseDemotion();
      await demotion;
      await checkedLink;
    } finally {
      releaseDemotion();
      await Promise.allSettled([demotion, linkAttempt, checkedLink].filter(Boolean));
      await Promise.all([demoter.sql.end(), linker.sql.end()]);
    }

    const assignments = await db
      .select({ id: organizationGroupEntities.id })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.groupId, group.id));
    expect(assignments).toEqual([]);
  }, 10_000);

  it("lets a link-first write commit before direct-organization role demotion", async () => {
    const group = await createGroup("Link-first organization role change");
    const linker = await createTestDb();
    const demoter = await createTestDb();
    let releaseLink!: () => void;
    let reportLinkReady!: () => void;
    let reportDemoterPid!: (pid: number) => void;
    const holdLink = new Promise<void>((resolveHold) => {
      releaseLink = resolveHold;
    });
    const linkReady = new Promise<void>((resolveReady) => {
      reportLinkReady = resolveReady;
    });
    const demoterPid = new Promise<number>((resolvePid) => {
      reportDemoterPid = resolvePid;
    });

    const linkMutation = linker.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE buwiz_app`;
      await tx`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
      await tx`
        INSERT INTO organization_group_entities (
          enterprise_account_id,
          group_id,
          organization_id,
          created_by
        ) VALUES (
          ${enterpriseAccountId}::uuid,
          ${group.id}::uuid,
          ${orgB},
          ${ownerUserId}
        )
      `;
      reportLinkReady();
      await holdLink;
    });

    let demotion: Promise<unknown> | undefined;
    try {
      await linkReady;
      demotion = demoter.sql.begin(async (tx) => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportDemoterPid(Number(backend.pid));
        await tx`
          UPDATE auth_members
          SET role = 'member'
          WHERE organization_id = ${orgB}
            AND user_id = ${ownerUserId}
        `;
      });
      await waitForBackendBlock(sqlClient, await demoterPid);
      releaseLink();
      await Promise.all([linkMutation, demotion]);
    } finally {
      releaseLink();
      await Promise.allSettled([linkMutation, demotion].filter(Boolean));
      await Promise.all([linker.sql.end(), demoter.sql.end()]);
    }

    const [assignment] = await db
      .select({ status: organizationGroupEntities.status })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.groupId, group.id));
    const [directMembership] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgB), eq(member.userId, ownerUserId)));
    expect(assignment.status).toBe("enabled");
    expect(directMembership.role).toBe("member");
  }, 10_000);

  it("returns retryable 40001 when organization-role revocation wins a restore race", async () => {
    const group = await createGroup("Revocation-first assignment restore");
    const assignment = await link(group.id, orgB);
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupEntities)
        .set({ status: "disabled" })
        .where(eq(organizationGroupEntities.id, assignment.entityId)),
    );
    const revoker = await createTestDb();
    const restorer = await createTestDb();
    let releaseRevocation!: () => void;
    let reportRevocationReady!: () => void;
    const holdRevocation = new Promise<void>((resolveHold) => {
      releaseRevocation = resolveHold;
    });
    const revocationReady = new Promise<void>((resolveReady) => {
      reportRevocationReady = resolveReady;
    });

    const revocation = revoker.sql.begin(async (tx) => {
      await tx`
        UPDATE auth_members
        SET role = 'member'
        WHERE organization_id = ${orgB}
          AND user_id = ${ownerUserId}
      `;
      reportRevocationReady();
      await holdRevocation;
    });

    try {
      await revocationReady;
      await expectDatabaseCode(
        () =>
          restorer.sql.begin(async (tx) => {
            await tx`SET LOCAL ROLE buwiz_app`;
            await tx`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
            await tx`
              UPDATE organization_group_entities
              SET status = 'enabled'
              WHERE id = ${assignment.entityId}::uuid
            `;
          }),
        "40001",
      );
      releaseRevocation();
      await revocation;
    } finally {
      releaseRevocation();
      await Promise.allSettled([revocation]);
      await Promise.all([revoker.sql.end(), restorer.sql.end()]);
    }

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupEntities)
            .set({ status: "enabled" })
            .where(eq(organizationGroupEntities.id, assignment.entityId)),
        ),
      "current actor must be an owner or admin of the assigned organization",
    );
  }, 10_000);

  it("lets restore-first commit before direct-organization role revocation", async () => {
    const group = await createGroup("Restore-first organization role change");
    const assignment = await link(group.id, orgB);
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupEntities)
        .set({ status: "disabled" })
        .where(eq(organizationGroupEntities.id, assignment.entityId)),
    );
    const restorer = await createTestDb();
    const revoker = await createTestDb();
    let releaseRestore!: () => void;
    let reportRestoreReady!: () => void;
    let reportRevokerPid!: (pid: number) => void;
    const holdRestore = new Promise<void>((resolveHold) => {
      releaseRestore = resolveHold;
    });
    const restoreReady = new Promise<void>((resolveReady) => {
      reportRestoreReady = resolveReady;
    });
    const revokerPid = new Promise<number>((resolvePid) => {
      reportRevokerPid = resolvePid;
    });

    const restore = restorer.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE buwiz_app`;
      await tx`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
      await tx`
        UPDATE organization_group_entities
        SET status = 'enabled'
        WHERE id = ${assignment.entityId}::uuid
      `;
      reportRestoreReady();
      await holdRestore;
    });

    let revocation: Promise<unknown> | undefined;
    try {
      await restoreReady;
      revocation = revoker.sql.begin(async (tx) => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportRevokerPid(Number(backend.pid));
        await tx`
          UPDATE auth_members
          SET role = 'member'
          WHERE organization_id = ${orgB}
            AND user_id = ${ownerUserId}
        `;
      });
      await waitForBackendBlock(sqlClient, await revokerPid);
      releaseRestore();
      await Promise.all([restore, revocation]);
    } finally {
      releaseRestore();
      await Promise.allSettled([restore, revocation].filter(Boolean));
      await Promise.all([restorer.sql.end(), revoker.sql.end()]);
    }

    const [finalAssignment] = await db
      .select({ status: organizationGroupEntities.status })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.id, assignment.entityId));
    const [directMembership] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgB), eq(member.userId, ownerUserId)));
    expect(finalAssignment.status).toBe("enabled");
    expect(directMembership.role).toBe("member");
  }, 10_000);

  it("blocks direct assignment authorization, identity, and allowance bypasses", async () => {
    const group = await createGroup("Direct assignment boundary group");

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroupEntities).values({
            enterpriseAccountId,
            groupId: group.id,
            organizationId: unmanagedOrg,
            createdBy: ownerUserId,
          }),
        ),
      "must be an owner or admin of the assigned organization",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroupEntities).values({
            enterpriseAccountId,
            groupId: group.id,
            organizationId: orgA,
            createdBy: limitedUserId,
          }),
        ),
      "created_by must match the current actor",
    );

    const [disabledAssignment] = await asRuntimeUser<Array<{ id: string }>>(ownerUserId, (tx) =>
      tx
        .insert(organizationGroupEntities)
        .values({
          enterpriseAccountId,
          groupId: group.id,
          organizationId: orgA,
          createdBy: ownerUserId,
        })
        .returning({ id: organizationGroupEntities.id }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupEntities)
        .set({ status: "disabled" })
        .where(eq(organizationGroupEntities.id, disabledAssignment.id)),
    );
    await db
      .delete(member)
      .where(and(eq(member.userId, ownerUserId), eq(member.organizationId, orgA)));
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupEntities)
            .set({ status: "enabled" })
            .where(eq(organizationGroupEntities.id, disabledAssignment.id)),
        ),
      "must be an owner or admin of the assigned organization",
    );
    await db.insert(member).values({
      id: `bg-restored-org-member-${crypto.randomUUID()}`,
      userId: ownerUserId,
      organizationId: orgA,
      role: "owner",
    });

    await asRuntimeUser(ownerUserId, (tx) =>
      tx.insert(organizationGroupEntities).values({
        enterpriseAccountId,
        groupId: group.id,
        organizationId: orgB,
        createdBy: ownerUserId,
      }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx.insert(organizationGroupEntities).values({
        enterpriseAccountId,
        groupId: group.id,
        organizationId: orgC,
        createdBy: ownerUserId,
      }),
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupEntities)
            .set({ status: "enabled" })
            .where(eq(organizationGroupEntities.id, disabledAssignment.id)),
        ),
      "linked-entity allowance is 2; current usage is 2",
    );
    await db.insert(member).values({
      id: `bg-unmanaged-org-member-${crypto.randomUUID()}`,
      userId: ownerUserId,
      organizationId: unmanagedOrg,
      role: "admin",
    });
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroupEntities).values({
            enterpriseAccountId,
            groupId: group.id,
            organizationId: unmanagedOrg,
            createdBy: ownerUserId,
          }),
        ),
      "linked-entity allowance is 2; current usage is 2",
    );
  });

  it("rejects a direct runtime group insert that has no eligible owner at commit", async () => {
    const name = `Ownerless runtime group ${crypto.randomUUID()}`;
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroups).values({
            enterpriseAccountId,
            name,
            reportingTimezone: "UTC",
            defaultReportingCurrency: "USD",
            createdBy: ownerUserId,
          }),
        ),
      "at least one eligible owner at commit",
    );
    const rows = await db
      .select({ id: organizationGroups.id })
      .from(organizationGroups)
      .where(eq(organizationGroups.name, name));
    expect(rows).toEqual([]);
  });

  it("rejects invalid Business Group names on direct runtime insert", async () => {
    const name = ` Untrimmed runtime group ${crypto.randomUUID()} `;
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroups).values({
            enterpriseAccountId,
            name,
            reportingTimezone: "UTC",
            defaultReportingCurrency: "USD",
            createdBy: ownerUserId,
          }),
        ),
      "organization_groups_name_check",
    );
    const rows = await db
      .select({ id: organizationGroups.id })
      .from(organizationGroups)
      .where(eq(organizationGroups.name, name));
    expect(rows).toEqual([]);
  });

  it("requires Enterprise-backed group members and audits direct membership changes", async () => {
    const group = await createGroup("Direct membership group");

    const evidencePrivileges = await sqlClient`
      SELECT
        runtime_role.role_name,
        expected.table_name,
        expected.privilege,
        has_table_privilege(
          runtime_role.role_name,
          expected.table_name,
          expected.privilege
        ) AS allowed,
        expected.allowed AS expected
      FROM unnest(ARRAY['app_runtime', 'buwiz_app']::text[])
        AS runtime_role(role_name)
      CROSS JOIN (
        VALUES
          ('auth_users', 'SELECT', true),
          ('auth_users', 'INSERT', true),
          ('auth_users', 'UPDATE', true),
          ('auth_users', 'DELETE', true),
          ('auth_users', 'TRUNCATE', false),
          ('auth_users', 'TRIGGER', false),
          ('auth_users', 'REFERENCES', false),
          ('organization_group_audit_events', 'SELECT', true),
          ('organization_group_audit_events', 'INSERT', false),
          ('organization_group_audit_events', 'UPDATE', false),
          ('organization_group_audit_events', 'DELETE', false),
          ('organization_group_audit_events', 'TRUNCATE', false),
          ('organization_group_audit_events', 'TRIGGER', false),
          ('organization_group_audit_events', 'REFERENCES', false),
          ('entitlement_events', 'SELECT', true),
          ('entitlement_events', 'INSERT', false),
          ('entitlement_events', 'UPDATE', false),
          ('entitlement_events', 'DELETE', false),
          ('entitlement_events', 'TRUNCATE', false),
          ('entitlement_events', 'TRIGGER', false),
          ('entitlement_events', 'REFERENCES', false),
          ('business_group_projection_reconciliation_events', 'SELECT', true),
          ('business_group_projection_reconciliation_events', 'INSERT', true),
          ('business_group_projection_reconciliation_events', 'UPDATE', false),
          ('business_group_projection_reconciliation_events', 'DELETE', false),
          ('business_group_projection_reconciliation_events', 'TRUNCATE', false),
          ('business_group_projection_reconciliation_events', 'TRIGGER', false),
          ('business_group_projection_reconciliation_events', 'REFERENCES', false)
      ) AS expected(table_name, privilege, allowed)
      ORDER BY runtime_role.role_name, expected.table_name, expected.privilege
    `;
    expect(evidencePrivileges.filter((row) => row.allowed !== row.expected)).toEqual([]);

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, async (tx) => {
          await tx.execute(drizzleSql.raw("TRUNCATE TABLE organization_group_audit_events"));
          throw new Error("runtime TRUNCATE unexpectedly succeeded");
        }),
      "permission denied",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.execute(drizzleSql`
            SELECT has_active_business_groups_entitlement(${enterpriseAccountId}::uuid)
          `),
        ),
      "permission denied",
    );

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.insert(organizationGroupAuditEvents).values({
            enterpriseAccountId,
            groupId: group.id,
            actorUserId: ownerUserId,
            eventType: "group.renamed",
            subjectType: "group",
            subjectId: group.id,
            details: { fabricated: true },
          }),
        ),
      "permission denied",
    );

    await expect(
      asRuntimeUser(ownerUserId, (tx) =>
        tx.insert(organizationGroupMembers).values({
          groupId: group.id,
          userId: outsiderUserId,
          role: "viewer",
        }),
      ),
    ).rejects.toThrow();

    await asRuntimeUser(ownerUserId, (tx) =>
      tx.insert(organizationGroupMembers).values({
        groupId: group.id,
        userId: limitedUserId,
        role: "analyst",
      }),
    );
    const [initialMembership] = await db
      .select({
        id: organizationGroupMembers.id,
        createdAt: organizationGroupMembers.createdAt,
        updatedAt: organizationGroupMembers.updatedAt,
      })
      .from(organizationGroupMembers)
      .where(
        and(
          eq(organizationGroupMembers.groupId, group.id),
          eq(organizationGroupMembers.userId, limitedUserId),
        ),
      );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx
            .update(organizationGroupMembers)
            .set({ id: crypto.randomUUID(), createdAt: new Date("2000-01-01T00:00:00.000Z") })
            .where(eq(organizationGroupMembers.id, initialMembership.id)),
        ),
      "membership id, group_id, user_id, and created_at are immutable",
    );
    const [noOpMembership] = await asRuntimeUser<Array<{ updatedAt: Date }>>(ownerUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "analyst", updatedAt: new Date("2000-01-01T00:00:00.000Z") })
        .where(eq(organizationGroupMembers.id, initialMembership.id))
        .returning({ updatedAt: organizationGroupMembers.updatedAt }),
    );
    expect(noOpMembership.updatedAt.getTime()).toBe(initialMembership.updatedAt.getTime());

    const [demotedMembership] = await asRuntimeUser<Array<{ updatedAt: Date }>>(ownerUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "viewer", updatedAt: new Date("2000-01-01T00:00:00.000Z") })
        .where(eq(organizationGroupMembers.id, initialMembership.id))
        .returning({ updatedAt: organizationGroupMembers.updatedAt }),
    );
    expect(demotedMembership.updatedAt.getTime()).toBeGreaterThan(
      initialMembership.updatedAt.getTime(),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .delete(organizationGroupMembers)
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        ),
    );

    const events = await db
      .select({
        eventType: organizationGroupAuditEvents.eventType,
        actorUserId: organizationGroupAuditEvents.actorUserId,
      })
      .from(organizationGroupAuditEvents)
      .where(
        and(
          eq(organizationGroupAuditEvents.groupId, group.id),
          eq(organizationGroupAuditEvents.subjectId, limitedUserId),
        ),
      );
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["member.added", "member.role_changed", "member.removed"]),
    );
    expect(events.every((event) => event.actorUserId === ownerUserId)).toBe(true);
  });

  it("audits an auth-user cascade membership removal with a null actor", async () => {
    const group = await createGroup("User cascade audit group");
    await asRuntimeUser(ownerUserId, (tx) =>
      tx.insert(organizationGroupMembers).values({
        groupId: group.id,
        userId: limitedUserId,
        role: "viewer",
      }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroups)
        .set({ status: "archived" })
        .where(eq(organizationGroups.id, group.id)),
    );

    await db.delete(user).where(eq(user.id, limitedUserId));

    const [survivingGroup] = await db
      .select({ id: organizationGroups.id })
      .from(organizationGroups)
      .where(eq(organizationGroups.id, group.id));
    expect(survivingGroup).toEqual({ id: group.id });
    const removalEvents = await db
      .select({ actorUserId: organizationGroupAuditEvents.actorUserId })
      .from(organizationGroupAuditEvents)
      .where(
        and(
          eq(organizationGroupAuditEvents.groupId, group.id),
          eq(organizationGroupAuditEvents.eventType, "member.removed"),
          eq(organizationGroupAuditEvents.subjectId, limitedUserId),
        ),
      );
    expect(removalEvents).toEqual([{ actorUserId: null }]);
  });

  it("requires group-role cleanup before Enterprise membership demotion or deletion", async () => {
    const group = await createGroup("Enterprise membership lifecycle group");
    await asRuntimeUser(ownerUserId, (tx) =>
      tx.insert(organizationGroupMembers).values({
        groupId: group.id,
        userId: limitedUserId,
        role: "owner",
      }),
    );

    await expectDatabaseError(
      () =>
        db
          .update(enterpriseAccountMembers)
          .set({ userId: outsiderUserId })
          .where(
            and(
              eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
              eq(enterpriseAccountMembers.userId, limitedUserId),
            ),
          ),
      "enterprise_account_id and user_id are immutable",
    );
    await expectDatabaseError(
      () =>
        db
          .update(enterpriseAccountMembers)
          .set({ role: "billing_admin" })
          .where(
            and(
              eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
              eq(enterpriseAccountMembers.userId, limitedUserId),
            ),
          ),
      "owner roles before changing",
    );

    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .update(organizationGroupMembers)
        .set({ role: "admin" })
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        ),
    );
    await db
      .update(enterpriseAccountMembers)
      .set({ role: "billing_admin" })
      .where(
        and(
          eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
          eq(enterpriseAccountMembers.userId, limitedUserId),
        ),
      );
    await expectDatabaseError(
      () =>
        db
          .delete(enterpriseAccountMembers)
          .where(
            and(
              eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
              eq(enterpriseAccountMembers.userId, limitedUserId),
            ),
          ),
      "Remove Business Group memberships",
    );

    await asRuntimeUser(ownerUserId, (tx) =>
      tx
        .delete(organizationGroupMembers)
        .where(
          and(
            eq(organizationGroupMembers.groupId, group.id),
            eq(organizationGroupMembers.userId, limitedUserId),
          ),
        ),
    );
    const deleted = await db
      .delete(enterpriseAccountMembers)
      .where(
        and(
          eq(enterpriseAccountMembers.enterpriseAccountId, enterpriseAccountId),
          eq(enterpriseAccountMembers.userId, limitedUserId),
        ),
      )
      .returning({ id: enterpriseAccountMembers.id });
    expect(deleted).toHaveLength(1);
  });

  it("blocks the admin-guard migration when a group has no eligible owner", async () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0034_business_group_admin_guards.sql"),
      "utf8",
    );
    await expectDatabaseError(
      () =>
        sqlClient.begin(async (tx) => {
          await tx`
            INSERT INTO organization_groups (
              enterprise_account_id,
              name,
              reporting_timezone,
              default_reporting_currency,
              created_by
            ) VALUES (
              ${enterpriseAccountId},
              'Orphaned migration preflight group',
              'UTC',
              'USD',
              ${ownerUserId}
            )
          `;
          await tx.unsafe(migration);
        }),
      "groups without an eligible owner",
    );
  });

  it("blocks the admin-guard migration when a group member lacks Enterprise membership", async () => {
    const group = await createGroup("Membership preflight group");
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0034_business_group_admin_guards.sql"),
      "utf8",
    );
    await expectDatabaseError(
      () =>
        sqlClient.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          await tx`
            INSERT INTO organization_group_members (group_id, user_id, role)
            VALUES (${group.id}, ${outsiderUserId}, 'viewer')
          `;
          await tx.unsafe("SET LOCAL session_replication_role = origin");
          await tx.unsafe(migration);
        }),
      "group memberships without matching Enterprise membership",
    );
  });

  it("blocks the admin-guard migration when any group owner lacks an eligible Enterprise role", async () => {
    const group = await createGroup("Ineligible owner preflight group");
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0034_business_group_admin_guards.sql"),
      "utf8",
    );
    await expectDatabaseError(
      () =>
        sqlClient.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          await tx`
            INSERT INTO organization_group_members (group_id, user_id, role)
            VALUES (${group.id}, ${billingUserId}, 'owner')
          `;
          await tx.unsafe("SET LOCAL session_replication_role = origin");
          await tx.unsafe(migration);
        }),
      `ineligible group-owner memberships: ${group.id}:${billingUserId}`,
    );
  });

  it("blocks the admin-guard migration when an archived group still has an enabled entity", async () => {
    const group = await createGroup("Archived assignment preflight group");
    const assignment = await link(group.id, orgA);
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0034_business_group_admin_guards.sql"),
      "utf8",
    );
    await expectDatabaseError(
      () =>
        sqlClient.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          await tx`
            UPDATE organization_groups
            SET status = 'archived'
            WHERE id = ${group.id}
          `;
          await tx.unsafe("SET LOCAL session_replication_role = origin");
          await tx.unsafe(migration);
        }),
      `archived groups with enabled entities: ${group.id}:${assignment.entityId}`,
    );
  });

  it("renames, archives, and restores a group without restoring former assignments", async () => {
    const group = await createGroup();
    await link(group.id, orgA);

    const renamed = await asRuntimeUser(ownerUserId, (tx) =>
      renameBusinessGroup(tx, {
        groupId: group.id,
        userId: ownerUserId,
        name: "  Ironwood Operating Companies  ",
      }),
    );
    expect(renamed.name).toBe("Ironwood Operating Companies");

    const archiveResult = await asRuntimeUser(ownerUserId, (tx) =>
      archiveBusinessGroup(tx, { groupId: group.id, userId: ownerUserId }),
    );
    expect(archiveResult.disabledEntityCount).toBe(1);
    expect(await getBusinessGroupsEntityUsage(db, enterpriseAccountId)).toBe(0);
    await expect(getAccessibleGroupEntities(db, group.id, ownerUserId)).rejects.toBeInstanceOf(
      BusinessGroupAccessError,
    );

    const [archived] = (await listBusinessGroups(db, ownerUserId, enterpriseAccountId)).filter(
      (candidate) => candidate.id === group.id,
    );
    expect(archived).toMatchObject({
      name: "Ironwood Operating Companies",
      status: "archived",
      entityCount: 0,
    });
    const archivedMembers = await asRuntimeUser(ownerUserId, (tx) =>
      listBusinessGroupMembers(tx, group.id, ownerUserId),
    );
    expect(archivedMembers).toEqual([
      expect.objectContaining({ userId: ownerUserId, role: "owner" }),
    ]);
    const memberCandidates = await asRuntimeUser(ownerUserId, (tx) =>
      listBusinessGroupMemberCandidates(tx, group.id, ownerUserId),
    );
    expect(memberCandidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: limitedUserId, groupRole: null })]),
    );

    const replacement = await createGroup("Replacement Portfolio");
    await link(replacement.id, orgA);
    await asRuntimeUser(ownerUserId, (tx) =>
      restoreBusinessGroup(tx, { groupId: group.id, userId: ownerUserId }),
    );
    const restoredView = await getAccessibleGroupEntities(db, group.id, ownerUserId);
    expect(restoredView.entities).toEqual([]);

    const auditEvents = await db
      .select({ eventType: organizationGroupAuditEvents.eventType })
      .from(organizationGroupAuditEvents)
      .where(eq(organizationGroupAuditEvents.groupId, group.id));
    expect(auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["group.renamed", "group.archived", "group.restored"]),
    );
  });

  it("serializes concurrent renames so audit events record the actual previous name", async () => {
    const group = await createGroup();
    const concurrent = await createTestDb();
    try {
      await Promise.all([
        db.transaction((tx) =>
          renameBusinessGroup(tx, {
            groupId: group.id,
            userId: ownerUserId,
            name: "Alpha Portfolio",
          }),
        ),
        concurrent.db.transaction((tx) =>
          renameBusinessGroup(tx, {
            groupId: group.id,
            userId: ownerUserId,
            name: "Beta Portfolio",
          }),
        ),
      ]);
    } finally {
      await concurrent.sql.end();
    }

    const renameEvents = await db
      .select({ details: organizationGroupAuditEvents.details })
      .from(organizationGroupAuditEvents)
      .where(
        and(
          eq(organizationGroupAuditEvents.groupId, group.id),
          eq(organizationGroupAuditEvents.eventType, "group.renamed"),
        ),
      );
    expect(renameEvents).toHaveLength(2);
    const transitions = renameEvents.map(
      (event) =>
        event.details as {
          previousName: string;
          name: string;
        },
    );
    const first = transitions.find((event) => event.previousName === "Ironwood Portfolio");
    expect(first).toBeDefined();
    expect(transitions).toContainEqual(expect.objectContaining({ previousName: first!.name }));
  });

  it("returns retryable 40001 instead of deadlocking archive against an in-flight unlink", async () => {
    const group = await createGroup("Archive serialization retry");
    const assignment = await link(group.id, orgA);
    const unlinker = await createTestDb();
    const archiver = await createTestDb();
    let releaseUnlink!: () => void;
    let reportEntityLocked!: () => void;
    let reportArchiverPid!: (pid: number) => void;
    const holdUnlink = new Promise<void>((resolveHold) => {
      releaseUnlink = resolveHold;
    });
    const entityLocked = new Promise<void>((resolveReady) => {
      reportEntityLocked = resolveReady;
    });
    const archiverPid = new Promise<number>((resolvePid) => {
      reportArchiverPid = resolvePid;
    });

    const unlink = unlinker.sql.begin(async (tx) => {
      await tx`
        SELECT id
        FROM organization_group_entities
        WHERE id = ${assignment.entityId}::uuid
        FOR UPDATE
      `;
      reportEntityLocked();
      await holdUnlink;
      await tx`
        UPDATE organization_group_entities
        SET status = 'disabled'
        WHERE id = ${assignment.entityId}::uuid
      `;
    });

    let archive: Promise<unknown> | undefined;
    let checkedUnlink: Promise<void> | undefined;
    try {
      await entityLocked;
      archive = archiver.sql.begin(async (tx) => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportArchiverPid(Number(backend.pid));
        await tx`
          UPDATE organization_groups
          SET status = 'archived'
          WHERE id = ${group.id}::uuid
        `;
      });
      await waitForBackendBlock(sqlClient, await archiverPid);
      checkedUnlink = expectDatabaseCode(() => unlink, "40001");
      releaseUnlink();
      await checkedUnlink;
      await archive;
    } finally {
      releaseUnlink();
      await Promise.allSettled([unlink, archive, checkedUnlink].filter(Boolean));
      await Promise.all([unlinker.sql.end(), archiver.sql.end()]);
    }

    const [finalGroup] = await db
      .select({ status: organizationGroups.status })
      .from(organizationGroups)
      .where(eq(organizationGroups.id, group.id));
    const [finalAssignment] = await db
      .select({ status: organizationGroupEntities.status })
      .from(organizationGroupEntities)
      .where(eq(organizationGroupEntities.id, assignment.entityId));
    expect(finalGroup.status).toBe("archived");
    expect(finalAssignment.status).toBe("disabled");
  }, 10_000);

  it("makes a creator-first group bootstrap visible before Enterprise-role demotion rechecks", async () => {
    const creator = await createTestDb();
    const demoter = await createTestDb();
    let releaseCreation!: () => void;
    let reportCreationReady!: () => void;
    let reportDemoterPid!: (pid: number) => void;
    const holdCreation = new Promise<void>((resolveHold) => {
      releaseCreation = resolveHold;
    });
    const creationReady = new Promise<void>((resolveReady) => {
      reportCreationReady = resolveReady;
    });
    const demoterPid = new Promise<number>((resolvePid) => {
      reportDemoterPid = resolvePid;
    });
    const groupName = `Creator-first bootstrap ${crypto.randomUUID()}`;

    const creation = creator.sql.begin(async (tx) => {
      const [group] = await tx`
          INSERT INTO organization_groups (
            enterprise_account_id,
            name,
            reporting_timezone,
            default_reporting_currency,
            created_by
          ) VALUES (
            ${enterpriseAccountId},
            ${groupName},
            'UTC',
            'USD',
            ${ownerUserId}
          )
          RETURNING id
        `;
      await tx`
          INSERT INTO organization_group_members (group_id, user_id, role)
          VALUES (${group.id}, ${ownerUserId}, 'owner')
        `;
      reportCreationReady();
      await holdCreation;
      return group.id as string;
    });

    let demotion: Promise<unknown> | undefined;
    let checkedDemotion: Promise<void> | undefined;
    try {
      await creationReady;
      demotion = demoter.sql.begin(async (tx) => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportDemoterPid(Number(backend.pid));
        await tx`
            UPDATE enterprise_account_members
            SET role = 'billing_admin'
            WHERE enterprise_account_id = ${enterpriseAccountId}
              AND user_id = ${ownerUserId}
          `;
      });
      checkedDemotion = expectDatabaseError(
        () => demotion!,
        "Transfer or demote Business Group owner roles",
      );
      await waitForBackendBlock(sqlClient, await demoterPid);
      releaseCreation();
      await creation;
      await checkedDemotion;
    } finally {
      releaseCreation();
      await Promise.allSettled([creation, demotion, checkedDemotion].filter(Boolean));
      await Promise.all([creator.sql.end(), demoter.sql.end()]);
    }
  }, 10_000);

  it("makes a demotion-first Enterprise-role change reject a stale group bootstrap", async () => {
    const creator = await createTestDb();
    const demoter = await createTestDb();
    let releaseDemotion!: () => void;
    let reportDemotionReady!: () => void;
    let reportCreatorPid!: (pid: number) => void;
    const holdDemotion = new Promise<void>((resolveHold) => {
      releaseDemotion = resolveHold;
    });
    const demotionReady = new Promise<void>((resolveReady) => {
      reportDemotionReady = resolveReady;
    });
    const creatorPid = new Promise<number>((resolvePid) => {
      reportCreatorPid = resolvePid;
    });
    const groupName = `Demotion-first bootstrap ${crypto.randomUUID()}`;

    const demotion = demoter.sql.begin(async (tx) => {
      await tx`
          UPDATE enterprise_account_members
          SET role = 'billing_admin'
          WHERE enterprise_account_id = ${enterpriseAccountId}
            AND user_id = ${ownerUserId}
        `;
      reportDemotionReady();
      await holdDemotion;
    });

    let creation: Promise<unknown> | undefined;
    let checkedCreation: Promise<void> | undefined;
    try {
      await demotionReady;
      creation = creator.sql.begin(async (tx) => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportCreatorPid(Number(backend.pid));
        await tx`
            INSERT INTO organization_groups (
              enterprise_account_id,
              name,
              reporting_timezone,
              default_reporting_currency,
              created_by
            ) VALUES (
              ${enterpriseAccountId},
              ${groupName},
              'UTC',
              'USD',
              ${ownerUserId}
            )
          `;
      });
      checkedCreation = expectDatabaseError(
        () => creation!,
        "A Business Group creator must be an Enterprise owner or group_admin",
      );
      await waitForBackendBlock(sqlClient, await creatorPid);
      releaseDemotion();
      await demotion;
      await checkedCreation;
    } finally {
      releaseDemotion();
      await Promise.allSettled([demotion, creation, checkedCreation].filter(Boolean));
      await Promise.all([creator.sql.end(), demoter.sql.end()]);
    }
  }, 10_000);

  it("forces a full retry when an actor Enterprise-role revocation wins the account lock", async () => {
    const group = await createGroup("Actor revocation serialization");
    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "admin",
      }),
    );
    const revoker = await createTestDb();
    const mutator = await createTestDb();
    let releaseRevocation!: () => void;
    let reportRevocationReady!: () => void;
    const holdRevocation = new Promise<void>((resolveHold) => {
      releaseRevocation = resolveHold;
    });
    const revocationReady = new Promise<void>((resolveReady) => {
      reportRevocationReady = resolveReady;
    });

    const revocation = revoker.sql.begin(async (tx) => {
      await tx`
        UPDATE enterprise_account_members
        SET role = 'billing_admin'
        WHERE enterprise_account_id = ${enterpriseAccountId}::uuid
          AND user_id = ${limitedUserId}
      `;
      reportRevocationReady();
      await holdRevocation;
    });

    try {
      await revocationReady;
      await expectDatabaseCode(
        () =>
          mutator.sql.begin(async (tx) => {
            await tx`SET LOCAL ROLE buwiz_app`;
            await tx`SELECT set_config('app.current_user_id', ${limitedUserId}, true)`;
            await tx`
              UPDATE organization_groups
              SET name = 'Stale actor rename'
              WHERE id = ${group.id}::uuid
            `;
          }),
        "40001",
      );
      releaseRevocation();
      await revocation;
    } finally {
      releaseRevocation();
      await Promise.allSettled([revocation]);
      await Promise.all([revoker.sql.end(), mutator.sql.end()]);
    }

    await expect(
      asRuntimeUser(limitedUserId, (tx) =>
        renameBusinessGroup(tx, {
          groupId: group.id,
          userId: limitedUserId,
          name: "Denied after role revocation",
        }),
      ),
    ).rejects.toThrow("Enterprise owner or group-admin access is required");
  }, 10_000);

  it("serializes opposite-group member inserts through the account namespace", async () => {
    const firstGroup = await createGroup("Opposite ordering one");
    const secondGroup = await createGroup("Opposite ordering two");
    const firstWriter = await createTestDb();
    const secondWriter = await createTestDb();
    let releaseFirstWriter!: () => void;
    let reportFirstInsert!: () => void;
    let reportSecondPid!: (pid: number) => void;
    const holdFirstWriter = new Promise<void>((resolveHold) => {
      releaseFirstWriter = resolveHold;
    });
    const firstInsertReady = new Promise<void>((resolveReady) => {
      reportFirstInsert = resolveReady;
    });
    const secondPid = new Promise<number>((resolvePid) => {
      reportSecondPid = resolvePid;
    });

    const firstMutation = firstWriter.sql.begin(async (tx) => {
      await tx`
        INSERT INTO organization_group_members (group_id, user_id, role)
        VALUES (${firstGroup.id}, ${limitedUserId}, 'viewer')
      `;
      reportFirstInsert();
      await holdFirstWriter;
      await tx`
        INSERT INTO organization_group_members (group_id, user_id, role)
        VALUES (${secondGroup.id}, ${limitedUserId}, 'viewer')
      `;
    });

    let secondMutation: Promise<unknown> | undefined;
    try {
      await firstInsertReady;
      secondMutation = secondWriter.sql.begin(async (tx) => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        reportSecondPid(Number(backend.pid));
        await tx`
          INSERT INTO organization_group_members (group_id, user_id, role)
          VALUES (${secondGroup.id}, ${billingUserId}, 'viewer')
        `;
        await tx`
          INSERT INTO organization_group_members (group_id, user_id, role)
          VALUES (${firstGroup.id}, ${billingUserId}, 'viewer')
        `;
      });
      await waitForBackendBlock(sqlClient, await secondPid);
      releaseFirstWriter();
      await Promise.all([firstMutation, secondMutation]);
    } finally {
      releaseFirstWriter();
      await Promise.allSettled([firstMutation, secondMutation].filter(Boolean));
      await Promise.all([firstWriter.sql.end(), secondWriter.sql.end()]);
    }

    const insertedMembers = await db
      .select({
        groupId: organizationGroupMembers.groupId,
        userId: organizationGroupMembers.userId,
      })
      .from(organizationGroupMembers)
      .where(
        and(
          drizzleSql`${organizationGroupMembers.groupId} IN (${firstGroup.id}::uuid, ${secondGroup.id}::uuid)`,
          drizzleSql`${organizationGroupMembers.userId} IN (${limitedUserId}, ${billingUserId})`,
        ),
      );
    expect(insertedMembers).toHaveLength(4);
  }, 10_000);

  it("audits member changes and never removes the final owner", async () => {
    const group = await createGroup();
    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "admin",
      }),
    );
    await expect(
      asRuntimeUser(limitedUserId, (tx) =>
        removeBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: limitedUserId,
          targetUserId: ownerUserId,
        }),
      ),
    ).rejects.toThrow("Only a Business Group owner can remove an owner");

    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: limitedUserId,
        role: "owner",
      }),
    );
    await asRuntimeUser(ownerUserId, (tx) =>
      addBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: ownerUserId,
        targetUserId: ownerUserId,
        role: "viewer",
      }),
    );
    await asRuntimeUser(limitedUserId, (tx) =>
      removeBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: limitedUserId,
        targetUserId: ownerUserId,
      }),
    );
    await expect(
      asRuntimeUser(limitedUserId, (tx) =>
        removeBusinessGroupMember(tx, {
          groupId: group.id,
          actorUserId: limitedUserId,
          targetUserId: limitedUserId,
        }),
      ),
    ).rejects.toThrow("at least one eligible owner");

    const auditEvents = await db
      .select({ eventType: organizationGroupAuditEvents.eventType })
      .from(organizationGroupAuditEvents)
      .where(eq(organizationGroupAuditEvents.groupId, group.id));
    expect(auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["member.added", "member.role_changed", "member.removed"]),
    );
  });

  it("provides an operator-only atomic owner recovery for locked archived groups", async () => {
    const group = await createGroup("Locked ownership recovery");
    await asRuntimeUser(ownerUserId, (tx) =>
      archiveBusinessGroup(tx, { groupId: group.id, userId: ownerUserId }),
    );
    await db
      .update(accountEntitlements)
      .set({ status: "locked" })
      .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId));

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.execute(drizzleSql`
            INSERT INTO business_group_owner_transfer_context (
              transaction_id,
              group_id,
              actor_user_id,
              previous_owner_user_id,
              replacement_owner_user_id
            ) VALUES (
              txid_current(),
              ${group.id}::uuid,
              ${ownerUserId},
              ${ownerUserId},
              ${limitedUserId}
            )
          `),
        ),
      "permission denied",
    );
    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, (tx) =>
          tx.execute(drizzleSql`
            SELECT transfer_organization_group_ownership(
              ${group.id}::uuid,
              ${limitedUserId},
              'runtime-forgery-attempt'
            )
          `),
        ),
      "permission denied",
    );

    await expectDatabaseError(
      () =>
        asRuntimeUser(ownerUserId, async (tx) => {
          await tx.execute(drizzleSql`
            CREATE TEMP TABLE business_group_owner_transfer_context (
              transaction_id bigint NOT NULL,
              group_id uuid NOT NULL,
              actor_user_id text NOT NULL,
              previous_owner_user_id text NOT NULL,
              replacement_owner_user_id text NOT NULL
            ) ON COMMIT DROP
          `);
          await tx.execute(drizzleSql`
            INSERT INTO pg_temp.business_group_owner_transfer_context (
              transaction_id,
              group_id,
              actor_user_id,
              previous_owner_user_id,
              replacement_owner_user_id
            ) VALUES (
              txid_current(),
              ${group.id}::uuid,
              ${ownerUserId},
              ${ownerUserId},
              ${limitedUserId}
            )
          `);
          return tx.insert(organizationGroupMembers).values({
            groupId: group.id,
            userId: limitedUserId,
            role: "owner",
          });
        }),
      "archived Business Group permits only membership access reduction",
    );

    const [runtimePrivileges] = await sqlClient`
      SELECT
        has_table_privilege(
          'app_runtime',
          'business_group_owner_transfer_context',
          'INSERT'
        ) AS app_runtime_context_insert,
        has_table_privilege(
          'buwiz_app',
          'business_group_owner_transfer_context',
          'INSERT'
        ) AS buwiz_app_context_insert,
        has_function_privilege(
          'app_runtime',
          'transfer_organization_group_ownership(uuid,text,text)',
          'EXECUTE'
        ) AS app_runtime_transfer_execute,
        has_function_privilege(
          'buwiz_app',
          'transfer_organization_group_ownership(uuid,text,text)',
          'EXECUTE'
        ) AS buwiz_app_transfer_execute,
        has_function_privilege(
          'app_runtime',
          'has_active_business_groups_entitlement(uuid)',
          'EXECUTE'
        ) AS app_runtime_entitlement_probe_execute,
        has_function_privilege(
          'buwiz_app',
          'has_active_business_groups_entitlement(uuid)',
          'EXECUTE'
        ) AS buwiz_app_entitlement_probe_execute,
        has_function_privilege(
          'app_runtime',
          'lock_business_group_user_rows(text[])',
          'EXECUTE'
        ) AS app_runtime_lock_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'lock_business_group_user_rows(text[])',
          'EXECUTE'
        ) AS buwiz_app_lock_helper_execute,
        has_function_privilege(
          'app_runtime',
          'is_enterprise_organization_group_member(uuid,text)',
          'EXECUTE'
        ) AS app_runtime_membership_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'is_enterprise_organization_group_member(uuid,text)',
          'EXECUTE'
        ) AS buwiz_app_membership_helper_execute,
        has_function_privilege(
          'app_runtime',
          'is_organization_assigned_to_business_group(uuid,text,uuid,text)',
          'EXECUTE'
        ) AS app_runtime_assignment_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'is_organization_assigned_to_business_group(uuid,text,uuid,text)',
          'EXECUTE'
        ) AS buwiz_app_assignment_helper_execute,
        has_function_privilege(
          'app_runtime',
          'is_eligible_organization_group_owner(uuid,text)',
          'EXECUTE'
        ) AS app_runtime_owner_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'is_eligible_organization_group_owner(uuid,text)',
          'EXECUTE'
        ) AS buwiz_app_owner_helper_execute,
        has_function_privilege(
          'app_runtime',
          'can_manage_organization_group(uuid)',
          'EXECUTE'
        ) AS app_runtime_manage_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'can_manage_organization_group(uuid)',
          'EXECUTE'
        ) AS buwiz_app_manage_helper_execute,
        has_function_privilege(
          'app_runtime',
          'can_manage_organization_group_owners(uuid)',
          'EXECUTE'
        ) AS app_runtime_manage_owners_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'can_manage_organization_group_owners(uuid)',
          'EXECUTE'
        ) AS buwiz_app_manage_owners_helper_execute,
        has_function_privilege(
          'app_runtime',
          'can_bootstrap_organization_group(uuid,text)',
          'EXECUTE'
        ) AS app_runtime_bootstrap_helper_execute,
        has_function_privilege(
          'buwiz_app',
          'can_bootstrap_organization_group(uuid,text)',
          'EXECUTE'
        ) AS buwiz_app_bootstrap_helper_execute,
        has_schema_privilege('app_runtime', 'public', 'CREATE') AS app_runtime_public_create,
        has_schema_privilege('buwiz_app', 'public', 'CREATE') AS buwiz_app_public_create
    `;
    expect(runtimePrivileges).toEqual({
      app_runtime_context_insert: false,
      buwiz_app_context_insert: false,
      app_runtime_transfer_execute: false,
      buwiz_app_transfer_execute: false,
      app_runtime_entitlement_probe_execute: false,
      buwiz_app_entitlement_probe_execute: false,
      app_runtime_lock_helper_execute: false,
      buwiz_app_lock_helper_execute: false,
      app_runtime_membership_helper_execute: true,
      buwiz_app_membership_helper_execute: true,
      app_runtime_assignment_helper_execute: true,
      buwiz_app_assignment_helper_execute: true,
      app_runtime_owner_helper_execute: true,
      buwiz_app_owner_helper_execute: true,
      app_runtime_manage_helper_execute: true,
      buwiz_app_manage_helper_execute: true,
      app_runtime_manage_owners_helper_execute: true,
      buwiz_app_manage_owners_helper_execute: true,
      app_runtime_bootstrap_helper_execute: true,
      buwiz_app_bootstrap_helper_execute: true,
      app_runtime_public_create: false,
      buwiz_app_public_create: false,
    });

    await expectDatabaseError(
      () =>
        sqlClient.begin(async (tx) => {
          await tx`SELECT set_config('app.current_user_id', ${limitedUserId}, true)`;
          await tx`
            SELECT transfer_organization_group_ownership(
              ${group.id}::uuid,
              ${ownerUserId},
              'SUP-unauthorized-composed-role-check'
            )
          `;
        }),
      "Only the current eligible Business Group owner can transfer ownership",
    );

    await sqlClient.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
      await tx`
        SELECT transfer_organization_group_ownership(
          ${group.id}::uuid,
          ${limitedUserId},
          'SUP-4242 verified owner request'
        )
      `;
    });

    const transferredMembers = await db
      .select({ userId: organizationGroupMembers.userId, role: organizationGroupMembers.role })
      .from(organizationGroupMembers)
      .where(eq(organizationGroupMembers.groupId, group.id));
    expect(transferredMembers).toEqual(
      expect.arrayContaining([
        { userId: ownerUserId, role: "admin" },
        { userId: limitedUserId, role: "owner" },
      ]),
    );

    await expectDatabaseError(
      () =>
        asRuntimeUser(limitedUserId, (tx) =>
          tx
            .update(organizationGroupMembers)
            .set({ role: "owner" })
            .where(
              and(
                eq(organizationGroupMembers.groupId, group.id),
                eq(organizationGroupMembers.userId, ownerUserId),
              ),
            ),
        ),
      "archived Business Group permits only membership access reduction",
    );

    await asRuntimeUser(limitedUserId, (tx) =>
      removeBusinessGroupMember(tx, {
        groupId: group.id,
        actorUserId: limitedUserId,
        targetUserId: ownerUserId,
      }),
    );

    const [contextState] = await sqlClient`
      SELECT count(*)::integer AS count
      FROM business_group_owner_transfer_context
      WHERE group_id = ${group.id}::uuid
    `;
    expect(contextState.count).toBe(0);

    const [transferAudit] = await db
      .select({
        actorUserId: organizationGroupAuditEvents.actorUserId,
        details: organizationGroupAuditEvents.details,
      })
      .from(organizationGroupAuditEvents)
      .where(
        and(
          eq(organizationGroupAuditEvents.groupId, group.id),
          eq(organizationGroupAuditEvents.eventType, "group.owner_transferred"),
        ),
      );
    expect(transferAudit).toMatchObject({
      actorUserId: ownerUserId,
      details: {
        previousOwnerUserId: ownerUserId,
        replacementOwnerUserId: limitedUserId,
        supportReference: "SUP-4242 verified owner request",
      },
    });

    const remainingMembers = await db
      .select({ userId: organizationGroupMembers.userId, role: organizationGroupMembers.role })
      .from(organizationGroupMembers)
      .where(eq(organizationGroupMembers.groupId, group.id));
    expect(remainingMembers).toEqual([{ userId: limitedUserId, role: "owner" }]);
  });

  it("enforces enterprise write roles under the non-owner database role", async () => {
    const group = await asRuntimeUser(ownerUserId, (tx) =>
      createBusinessGroup(tx, {
        enterpriseAccountId,
        userId: ownerUserId,
        name: "Runtime-secured group",
        reportingTimezone: "UTC",
        defaultReportingCurrency: "USD",
      }),
    );
    expect(group.role).toBe("owner");

    await db
      .update(enterpriseAccountMembers)
      .set({ role: "billing_admin" })
      .where(eq(enterpriseAccountMembers.userId, limitedUserId));

    await expect(
      asRuntimeUser(limitedUserId, (tx) =>
        tx
          .insert(organizationGroups)
          .values({
            enterpriseAccountId,
            name: "Billing bypass attempt",
            reportingTimezone: "UTC",
            defaultReportingCurrency: "USD",
            createdBy: limitedUserId,
          })
          .returning({ id: organizationGroups.id }),
      ),
    ).rejects.toThrow();
    const bypassRows = await db
      .select({ id: organizationGroups.id })
      .from(organizationGroups)
      .where(eq(organizationGroups.name, "Billing bypass attempt"));
    expect(bypassRows).toEqual([]);

    const entitlementUpdates = await asRuntimeUser(limitedUserId, (tx) =>
      tx
        .update(accountEntitlements)
        .set({ includedEntityLimit: 999 })
        .where(eq(accountEntitlements.enterpriseAccountId, enterpriseAccountId))
        .returning({ id: accountEntitlements.id }),
    );
    expect(entitlementUpdates).toEqual([]);
  });
});
