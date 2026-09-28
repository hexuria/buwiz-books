/**
 * Jev approval lanes (Inbox v2 spec §8, §10): Settings → Jev approval, and the
 * "by Jev" panel and Undo on the Bills and Transactions entry screens.
 *
 * Changing a lane or the organization's Jev settings widens or narrows who may
 * approve papers, so every write is admin-only: aiTask:configure (held by
 * admins and owners) plus an explicit role check, like the other AI settings.
 * Undo is an Inbox decision and needs inbox:approve, like approving.
 */
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizationAccountingSettings } from "@/db/schema/inbox";
import { laneWalledKinds } from "@/lib/ai/autonomy";
import {
  demoteAutonomyLane,
  listAutonomyLanes,
  promoteAutonomyLane,
  setAutonomyLaneLimits,
  type AutonomyLaneSummary,
} from "@/lib/ai/autonomy-lanes";
import { loadJevEntryApproval } from "@/lib/inbox/jev-approval/entry";
import { JEV_LANE_KEY } from "@/lib/inbox/jev-approval/proposal";
import {
  loadJevApprovalSettings,
  updateJevApprovalSettings,
} from "@/lib/inbox/jev-approval/settings";
import { undoJevApproval } from "@/lib/inbox/jev-approval/undo";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
  type OrgServerContext,
} from "@/lib/server-context";

function isAdmin(role: string | null | undefined): boolean {
  return role === "admin" || role === "owner";
}

function assertAdmin(ctx: Pick<OrgServerContext, "role">): void {
  if (!isAdmin(ctx.role)) throw new Error("Only organization admins can change Jev approval.");
}

export interface JevLaneView {
  id: string;
  partyId: string | null;
  partyName: string | null;
  docKind: string | null;
  level: "watch" | "suggest" | "auto";
  amountCap: string | null;
  confidenceThreshold: string | null;
  promotedAt: Date | null;
  promotedByName: string | null;
  demotedAt: Date | null;
  agreement: AutonomyLaneSummary["agreement"];
  eligibility: {
    eligible: boolean;
    total: number;
    accepted: number;
    acceptanceRate: number;
    remaining: number;
    reason: string;
  };
  calibration: {
    buckets: Array<{ lower: number; upper: number; reviewed: number; acceptance: number | null }>;
    minimumThreshold: number | null;
    reason: string;
  };
}

export interface JevLanesView {
  canConfigure: boolean;
  settings: {
    autoApproveEnabled: boolean;
    makerCheckerOptIn: boolean;
    spotCheckRate: number;
    aiKillSwitch: boolean;
    requireDifferentApprover: boolean;
    /** Kinds still walled for the lane: while non-empty nothing Jev approves posts. */
    walledKinds: string[];
  };
  lanes: JevLaneView[];
}

function laneView(summary: AutonomyLaneSummary): JevLaneView {
  const { lane } = summary;
  return {
    id: lane.id,
    partyId: lane.partyId,
    partyName: summary.partyName,
    docKind: lane.docKind,
    level: lane.level,
    amountCap: lane.amountCap,
    confidenceThreshold: lane.confidenceThreshold,
    promotedAt: lane.promotedAt,
    promotedByName: summary.promotedByName,
    demotedAt: lane.demotedAt,
    agreement: summary.agreement,
    eligibility: { ...summary.eligibility },
    calibration: {
      buckets: summary.reliability.buckets.map((bucket) => ({
        lower: bucket.lower,
        upper: bucket.upper,
        reviewed: bucket.reviewed,
        acceptance: bucket.acceptance,
      })),
      minimumThreshold: summary.reliability.minimumThreshold,
      reason: summary.reliability.reason,
    },
  };
}

/** Every Jev approval lane with its agreement, eligibility and calibration. */
export const listJevLanes = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("aiTask", "view", async (ctx): Promise<JevLanesView> => {
    const [summaries, settings, accounting] = await Promise.all([
      listAutonomyLanes(ctx.db, ctx.orgId, JEV_LANE_KEY),
      loadJevApprovalSettings(ctx.db, ctx.orgId),
      ctx.db
        .select({
          requireDifferentApprover: organizationAccountingSettings.requireDifferentApprover,
        })
        .from(organizationAccountingSettings)
        .where(eq(organizationAccountingSettings.organizationId, ctx.orgId))
        .limit(1),
    ]);
    return {
      canConfigure: isAdmin(ctx.role),
      settings: {
        autoApproveEnabled: settings.autoApproveEnabled,
        makerCheckerOptIn: settings.makerCheckerOptIn,
        spotCheckRate: settings.spotCheckRate,
        aiKillSwitch: settings.aiKillSwitch,
        requireDifferentApprover: accounting[0]?.requireDifferentApprover ?? true,
        walledKinds: laneWalledKinds(JEV_LANE_KEY),
      },
      lanes: summaries.map(laneView),
    };
  }),
);

const promoteSchema = z.object({
  laneId: z.string().uuid(),
  to: z.enum(["suggest", "auto"]),
  amountCap: z.string().trim().max(40).optional(),
  confidenceThreshold: z.string().trim().max(10).optional(),
});

/** Promote a lane one level. Eligibility is re-verified at the moment of the flip. */
export const promoteJevLane = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => promoteSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "aiTask",
      "configure",
      { routeKey: "jev-lanes:promote", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertAdmin(ctx);
        const lane = await promoteAutonomyLane(ctx.db, {
          orgId: ctx.orgId,
          laneId: data.laneId,
          to: data.to,
          actorId: ctx.userId,
          amountCap: data.amountCap ?? null,
          confidenceThreshold: data.confidenceThreshold ?? null,
        });
        return { id: lane.id, level: lane.level };
      },
    ),
  );

const demoteSchema = z.object({
  laneId: z.string().uuid(),
  to: z.enum(["watch", "suggest"]),
});

/** Demote a lane by hand. Narrowing authority needs no eligibility. */
export const demoteJevLane = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => demoteSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "aiTask",
      "configure",
      { routeKey: "jev-lanes:demote", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertAdmin(ctx);
        const lane = await demoteAutonomyLane(ctx.db, {
          orgId: ctx.orgId,
          laneId: data.laneId,
          to: data.to,
          actorId: ctx.userId,
        });
        return { id: lane.id, level: lane.level };
      },
    ),
  );

const limitsSchema = z.object({
  laneId: z.string().uuid(),
  amountCap: z.string().trim().max(40).optional(),
  confidenceThreshold: z.string().trim().max(10).optional(),
});

/** Change an auto lane's cap or threshold; widening re-verifies eligibility. */
export const updateJevLaneLimits = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => limitsSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "aiTask",
      "configure",
      { routeKey: "jev-lanes:limits", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertAdmin(ctx);
        const lane = await setAutonomyLaneLimits(ctx.db, {
          orgId: ctx.orgId,
          laneId: data.laneId,
          actorId: ctx.userId,
          amountCap: data.amountCap ?? null,
          confidenceThreshold: data.confidenceThreshold ?? null,
        });
        return {
          id: lane.id,
          amountCap: lane.amountCap,
          confidenceThreshold: lane.confidenceThreshold,
        };
      },
    ),
  );

const settingsSchema = z.object({
  autoApproveEnabled: z.boolean().optional(),
  makerCheckerOptIn: z.boolean().optional(),
  spotCheckRate: z.string().trim().max(10).optional(),
});

/** The organization's Jev-approval switch, maker-checker opt-in and spot-check rate. */
export const updateJevApprovalSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => settingsSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "aiTask",
      "configure",
      { routeKey: "jev-lanes:settings", limit: 20, windowMs: 60_000 },
      async (ctx) => {
        assertAdmin(ctx);
        const settings = await updateJevApprovalSettings(ctx.db, {
          orgId: ctx.orgId,
          actorId: ctx.userId,
          ...data,
        });
        return {
          autoApproveEnabled: settings.autoApproveEnabled,
          makerCheckerOptIn: settings.makerCheckerOptIn,
          spotCheckRate: settings.spotCheckRate,
        };
      },
    ),
  );

const entrySchema = z.object({ journalHeaderId: z.string().uuid() });

/** Jev's approval of an entry, for its "by Jev" panel; null when a person approved it. */
export const getJevEntryApproval = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => entrySchema.parse(input))
  .handler(async ({ data }) =>
    withPermissionOrgContext("journal", "view", ({ orgId, db }) =>
      loadJevEntryApproval(db, orgId, data.journalHeaderId),
    ),
  );

const undoSchema = z.object({
  journalHeaderId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

/**
 * Undo a Jev approval: reversal only, the bill voided where there is one, and
 * the paper back in Needs you. Counts as a disagreement for the lane.
 */
export const undoJevApprovalFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => undoSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "inbox",
      "approve",
      { routeKey: "inbox:undo-jev-approval", limit: 20, windowMs: 60_000 },
      (ctx) => undoJevApproval(ctx, { journalHeaderId: data.journalHeaderId, reason: data.reason }),
    ),
  );
