/**
 * Rule snapshot server functions (Inbox v2 spec §6).
 *
 * The auth + rate-limit + org-scope shell around src/lib/inbox/rule-snapshots.ts
 * and the routine pin in src/lib/routines/service.ts. Snapshots and pins decide
 * which rules evaluate a routine's papers, so every write needs
 * agentRule:configure — the same grant as editing a rule's configuration —
 * and reads need agentRule:view.
 *
 * There is deliberately no update or delete function: snapshots are immutable,
 * and changing rules means creating a new snapshot and repinning.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  createRuleSnapshot as createRuleSnapshotRow,
  createRuleSnapshotInputSchema,
  getRuleSnapshot as getRuleSnapshotRow,
  listRuleSnapshots as listRuleSnapshotRows,
  ruleSnapshotIdInputSchema,
} from "@/lib/inbox/rule-snapshots";
import {
  pinRoutineRuleSnapshotInputSchema,
  setRoutineRuleSnapshot,
  unpinRoutineRuleSnapshotInputSchema,
} from "@/lib/routines/service";
import { withMutationPermissionOrgContext, withPermissionOrgContext } from "@/lib/server-context";

export const listRuleSnapshots = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("agentRule", "view", async ({ orgId, db }) =>
    listRuleSnapshotRows(db, orgId),
  ),
);

export const getRuleSnapshot = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => ruleSnapshotIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withPermissionOrgContext("agentRule", "view", async ({ orgId, db }) =>
      getRuleSnapshotRow(db, orgId, data.snapshotId),
    ),
  );

/** Freeze the organization's current live rule configuration into a new snapshot. */
export const createRuleSnapshot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createRuleSnapshotInputSchema.parse(input ?? {}))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "rule-snapshots:create", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        createRuleSnapshotRow(db, { orgId, actorId: userId, label: data.label }),
    ),
  );

/**
 * Pin a snapshot on a routine: as its enforced rules, or with `shadow: true`
 * as the snapshot evaluated alongside and logged. Pinning the routine's shadow
 * snapshot promotes it.
 */
export const pinRoutineRuleSnapshot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => pinRoutineRuleSnapshotInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "rule-snapshots:pin", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        setRoutineRuleSnapshot(db, {
          orgId,
          actorId: userId,
          routineId: data.routineId,
          slot: data.shadow ? "shadow" : "active",
          snapshotId: data.snapshotId,
        }),
    ),
  );

/** Return a routine to live rule configs (or clear its shadow snapshot). */
export const unpinRoutineRuleSnapshot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => unpinRoutineRuleSnapshotInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "rule-snapshots:unpin", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        setRoutineRuleSnapshot(db, {
          orgId,
          actorId: userId,
          routineId: data.routineId,
          slot: data.shadow ? "shadow" : "active",
          snapshotId: null,
        }),
    ),
  );
