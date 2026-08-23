/** Enterprise Business Groups server functions. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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
} from "../../lib/business-groups/service";
import {
  computeBusinessGroupsPerformance,
  computeGroupPerformance,
} from "../../lib/business-groups/performance";
import { computeProjectedBusinessGroupsPerformance } from "../../lib/business-groups/projected-performance";
import {
  findProjectionMismatches,
  recordProjectionMismatches,
} from "../../lib/business-groups/projection-reconciliation";
import {
  invalidProjectionAllowlistWarning,
  resolveBusinessGroupReportSource,
} from "../../lib/business-groups/report-source";
import {
  getBusinessGroupsEntityUsage,
  listEnterpriseAccountsForUser,
} from "../../lib/enterprise/entitlements";
import { triggerWorker } from "../../lib/jobs/trigger";
import {
  BUSINESS_GROUP_PROJECTION_JOB_TYPE,
  getReportingProjectionStates,
  requestAuthorizedReportingProjection,
} from "../../lib/reporting/projection";
import { withMutationSessionUserContext, withSessionUserContext } from "../../lib/server-context";
import { enforceRateLimit } from "../../lib/request-guards";
import { createLogger } from "../../lib/logger";

const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createGroupSchema = z.object({
  enterpriseAccountId: uuidSchema,
  name: z.string().trim().min(2).max(255),
  reportingTimezone: z.string().trim().min(1).max(64).default("UTC"),
  defaultReportingCurrency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
});

const groupIdSchema = z.object({ groupId: uuidSchema });
const renameGroupSchema = z.object({
  groupId: uuidSchema,
  name: z.string().trim().min(2).max(255),
});
const addEntitySchema = z.object({
  groupId: uuidSchema,
  organizationId: z.string().min(1).max(255),
});
const removeEntitySchema = z.object({ groupId: uuidSchema, entityId: uuidSchema });
const groupPerformanceSchema = z
  .object({
    groupId: uuidSchema,
    dateFrom: isoDateSchema,
    dateTo: isoDateSchema,
    compare: z.enum(["none", "prior_period"]).default("prior_period"),
  })
  .refine((value) => value.dateFrom <= value.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateTo"],
  });
const businessGroupsPerformanceSchema = z
  .object({
    groupIds: z.array(uuidSchema).min(1).max(50),
    dateFrom: isoDateSchema,
    dateTo: isoDateSchema,
    compare: z.enum(["none", "prior_period"]).default("prior_period"),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().min(1).max(25).default(25),
  })
  .refine((value) => value.dateFrom <= value.dateTo, {
    message: "dateFrom must be on or before dateTo",
    path: ["dateTo"],
  });
const groupMemberSchema = z.object({
  groupId: uuidSchema,
  targetUserId: z.string().min(1).max(255),
  role: z.enum(["owner", "admin", "analyst", "viewer"]),
});
const removeGroupMemberSchema = z.object({
  groupId: uuidSchema,
  targetUserId: z.string().min(1).max(255),
});
const refreshPerformanceSchema = z.object({
  groupIds: z.array(uuidSchema).min(1).max(50),
});

let invalidProjectionAllowlistWarningEmitted = false;

function businessGroupReportSource(enterpriseAccountId: string): "live" | "shadow" | "projection" {
  const resolved = resolveBusinessGroupReportSource({
    configuredSource: process.env.BUSINESS_GROUP_REPORT_SOURCE,
    configuredAccountAllowlist: process.env.BUSINESS_GROUP_PROJECTION_ACCOUNT_ALLOWLIST,
    enterpriseAccountId,
  });
  const warning = invalidProjectionAllowlistWarning(resolved.invalidAllowlistTokenCount);
  if (warning && !invalidProjectionAllowlistWarningEmitted) {
    invalidProjectionAllowlistWarningEmitted = true;
    console.warn(JSON.stringify(warning));
  }
  return resolved.source;
}

function projectionReconciliationTolerance(): number {
  const configured = Number(process.env.BUSINESS_GROUP_PROJECTION_RECONCILIATION_TOLERANCE ?? 0.01);
  return Number.isFinite(configured) && configured >= 0 ? configured : 0.01;
}

const logger = createLogger("api.business-groups");
export const getBusinessGroupsLanding = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionUserContext(async ({ db, userId }) => {
    const accounts = await listEnterpriseAccountsForUser(db, userId);
    return {
      hasEnterpriseAccount: accounts.length > 0,
      accounts: await Promise.all(
        accounts.map(async (account) => ({
          ...account,
          usage: await getBusinessGroupsEntityUsage(db, account.id),
          groups: await listBusinessGroups(db, userId, account.id),
          canCreateGroup: ["owner", "group_admin"].includes(account.role),
        })),
      ),
    };
  });
});

export const createOrganizationGroup = createServerFn({ method: "POST" })
  .validator((data: unknown) => createGroupSchema.parse(data))
  .handler(async ({ data: input }) => {
    return withMutationSessionUserContext(
      input.enterpriseAccountId,
      { routeKey: "business-groups:create", limit: 30, windowMs: 60_000 },
      ({ db, userId }) => createBusinessGroup(db, { ...input, userId }),
    );
  });

export const renameOrganizationGroup = createServerFn({ method: "POST" })
  .validator((data: unknown) => renameGroupSchema.parse(data))
  .handler(async ({ data: input }) => {
    return withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:rename", limit: 30, windowMs: 60_000 },
      ({ db, userId }) => renameBusinessGroup(db, { ...input, userId }),
    );
  });

export const archiveOrganizationGroup = createServerFn({ method: "POST" })
  .validator((data: unknown) => groupIdSchema.parse(data))
  .handler(async ({ data: input }) => {
    return withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:archive", limit: 10, windowMs: 60_000 },
      ({ db, userId }) => archiveBusinessGroup(db, { ...input, userId }),
    );
  });

export const restoreOrganizationGroup = createServerFn({ method: "POST" })
  .validator((data: unknown) => groupIdSchema.parse(data))
  .handler(async ({ data: input }) => {
    await withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:restore", limit: 10, windowMs: 60_000 },
      ({ db, userId }) => restoreBusinessGroup(db, { ...input, userId }),
    );
    return { success: true };
  });

export const getBusinessGroupEntities = createServerFn({ method: "GET" })
  .validator((data: unknown) => groupIdSchema.parse(data))
  .handler(async ({ data: { groupId } }) => {
    return withSessionUserContext(({ db, userId }) =>
      getAccessibleGroupEntities(db, groupId, userId),
    );
  });

export const getLinkableOrganizations = createServerFn({ method: "GET" })
  .validator((data: unknown) => groupIdSchema.parse(data))
  .handler(async ({ data: { groupId } }) => {
    return withSessionUserContext(({ db, userId }) =>
      listLinkableOrganizations(db, groupId, userId),
    );
  });

export const linkOrganizationToGroup = createServerFn({ method: "POST" })
  .validator((data: unknown) => addEntitySchema.parse(data))
  .handler(async ({ data: input }) => {
    return withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:link-organization", limit: 30, windowMs: 60_000 },
      ({ db, userId }) => addOrganizationToGroup(db, { ...input, userId }),
    );
  });

export const unlinkOrganizationFromGroup = createServerFn({ method: "POST" })
  .validator((data: unknown) => removeEntitySchema.parse(data))
  .handler(async ({ data: input }) => {
    await withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:unlink-organization", limit: 30, windowMs: 60_000 },
      ({ db, userId }) => removeOrganizationFromGroup(db, { ...input, userId }),
    );
    return { success: true };
  });

export const getBusinessGroupPerformance = createServerFn({ method: "GET" })
  .validator((data: unknown) => groupPerformanceSchema.parse(data))
  .handler(async ({ data: input }) => {
    const { access, userId } = await withSessionUserContext(async ({ db, userId }) => ({
      access: await getAccessibleGroupEntities(db, input.groupId, userId),
      userId,
    }));
    return computeGroupPerformance(access, {
      userId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      compare: input.compare,
    });
  });

export const getBusinessGroupsPerformance = createServerFn({ method: "GET" })
  .validator((data: unknown) => businessGroupsPerformanceSchema.parse(data))
  .handler(async ({ data: input }) => {
    const groupIds = [...new Set(input.groupIds)];
    const { groups, projected, projectionStates, source, userId } = await withSessionUserContext(
      async ({ db, userId }) => {
        // This read fans out across every entity of every selected group —
        // by far the most expensive query surface here. Rate-limit it per
        // user AND per selected group set (sorted, so re-ordering the same
        // ids cannot mint fresh buckets).
        enforceRateLimit({
          routeKey: "business-groups:performance",
          orgId: [...groupIds].sort().join(","),
          userId,
          limit: 30,
          windowMs: 60_000,
        });
        const groups = await getAccessibleGroupEntitiesForGroups(db, groupIds, userId);
        const source = businessGroupReportSource(groups[0].enterpriseAccountId);
        const organizationIds = [
          ...new Set(
            groups.flatMap((group) => group.access.entities.map((entity) => entity.organizationId)),
          ),
        ];
        const projectionStates =
          source === "live" ? new Map() : await getReportingProjectionStates(db, organizationIds);
        return {
          groups,
          source,
          userId,
          projectionStates,
          projected:
            source === "live"
              ? null
              : await computeProjectedBusinessGroupsPerformance(db, groups, {
                  dateFrom: input.dateFrom,
                  dateTo: input.dateTo,
                  compare: input.compare,
                  page: input.page,
                  pageSize: input.pageSize,
                  sourceMode: source === "shadow" ? "shadow" : "projected",
                  projectionStates,
                }),
        };
      },
    );

    if (source === "projection") return projected!;

    const live = await computeBusinessGroupsPerformance(groups, {
      userId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      compare: input.compare,
      page: input.page,
      pageSize: input.pageSize,
    });
    if (source === "shadow" && projected) {
      if (projected.projectionStatus === "ready") {
        const mismatches = findProjectionMismatches(live, projected, {
          tolerance: projectionReconciliationTolerance(),
          projectionVersions: projectionStates,
        });
        if (mismatches.length > 0) {
          await withSessionUserContext(({ db }) =>
            recordProjectionMismatches(db, mismatches, {
              dateFrom: input.dateFrom,
              dateTo: input.dateTo,
              compare: input.compare,
              selectedGroupIds: groupIds,
              projectionAsOf: projected.projectionAsOf,
            }),
          ).catch((error: unknown) => {
            // Shadow-mode reconciliation is the safety net for the projection
            // cutover — losing its evidence silently defeats the whole check.
            // Still non-fatal: the user gets their (live) report either way.
            logger.error("Failed to record projection mismatches", {
              groupIds,
              mismatchCount: mismatches.length,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
      return {
        ...live,
        sourceMode: "shadow" as const,
        projectionAsOf: projected.projectionAsOf,
        projectionLagSeconds: projected.projectionLagSeconds,
        projectionSyncAgeSeconds: projected.projectionSyncAgeSeconds,
        projectionStatus: projected.projectionStatus,
        incompleteEntityCount: projected.incompleteEntityCount,
        entityReadiness: projected.entityReadiness,
        entityReadinessSummary: projected.entityReadinessSummary,
        warnings:
          projected.projectionStatus === "ready"
            ? live.warnings
            : [...live.warnings, ...projected.warnings],
      };
    }
    return live;
  });

export const refreshBusinessGroupPerformance = createServerFn({ method: "POST" })
  .validator((data: unknown) => refreshPerformanceSchema.parse(data))
  .handler(async ({ data: input }) => {
    const groupIds = [...new Set(input.groupIds)];
    const { groups, userId } = await withMutationSessionUserContext(
      groupIds[0],
      { routeKey: "business-groups:refresh-performance", limit: 30, windowMs: 60_000 },
      async ({ db, userId }) => ({
        groups: await getAccessibleGroupEntitiesForGroups(db, groupIds, userId),
        userId,
      }),
    );
    const organizations = new Map<string, { organizationId: string; role: string; name: string }>();
    for (const group of groups) {
      for (const entity of group.access.entities) organizations.set(entity.organizationId, entity);
    }

    const requests: Array<{
      organizationId: string;
      jobId: string | null;
      requestedVersion: number;
    }> = [];
    const entities = [...organizations.values()];
    for (let offset = 0; offset < entities.length; offset += 6) {
      const batch = await Promise.all(
        entities.slice(offset, offset + 6).map((entity) =>
          requestAuthorizedReportingProjection({
            organizationId: entity.organizationId,
            userId,
            role: entity.role,
          }).then((request) => ({ organizationId: entity.organizationId, ...request })),
        ),
      );
      requests.push(...batch);
    }
    triggerWorker([BUSINESS_GROUP_PROJECTION_JOB_TYPE]);
    return {
      requestedAt: new Date().toISOString(),
      organizationCount: organizations.size,
      requests,
    };
  });

export const getBusinessGroupMembers = createServerFn({ method: "GET" })
  .validator((data: unknown) => groupIdSchema.parse(data))
  .handler(async ({ data: { groupId } }) => {
    return withSessionUserContext(({ db, userId }) =>
      listBusinessGroupMembers(db, groupId, userId),
    );
  });

export const getBusinessGroupMemberCandidates = createServerFn({ method: "GET" })
  .validator((data: unknown) => groupIdSchema.parse(data))
  .handler(async ({ data: { groupId } }) => {
    return withSessionUserContext(({ db, userId }) =>
      listBusinessGroupMemberCandidates(db, groupId, userId),
    );
  });

export const upsertBusinessGroupMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => groupMemberSchema.parse(data))
  .handler(async ({ data: input }) => {
    await withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:upsert-member", limit: 30, windowMs: 60_000 },
      ({ db, userId }) =>
        addBusinessGroupMember(db, {
          ...input,
          actorUserId: userId,
        }),
    );
    return { success: true };
  });

export const deleteBusinessGroupMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => removeGroupMemberSchema.parse(data))
  .handler(async ({ data: input }) => {
    await withMutationSessionUserContext(
      input.groupId,
      { routeKey: "business-groups:remove-member", limit: 30, windowMs: 60_000 },
      ({ db, userId }) =>
        removeBusinessGroupMember(db, {
          ...input,
          actorUserId: userId,
        }),
    );
    return { success: true };
  });
