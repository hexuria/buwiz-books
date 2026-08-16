// ============================================================================
// coa_scaffold job — draft the accounts a business is missing, and re-point
// any posting default that is unset or broken.
//
// Both steps end in a PENDING proposal. Nothing here writes to `accounts` or
// `category_mappings`; the appliers do, after a human with the underlying
// permission approves.
//
// Two preconditions are enforced here rather than in a prompt:
//
//   • The org must already have a chart. The deterministic preset owns the 8
//     roots, the 5-digit numbering, and the mapping-completeness guarantee; a
//     model asked to invent roots would fight all three. Zero accounts is a
//     typed run failure, not a retry.
//   • Model output reaches nothing until `validate-draft.ts` has re-derived it
//     from the org's own chart.
//
// A run that fails for a CONFIGURATION reason (spend cap, kill switch, no
// credential, task not allowed) records a typed failure and returns instead of
// throwing. Throwing would burn all three attempts and terminalize with a
// generic message — during onboarding, the worst possible moment for an
// opaque failure.
// ============================================================================

import { and, eq, inArray } from "drizzle-orm";
import { db, withOrgContext, type DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { organization } from "@/db/schema/auth";
import {
  aiComplete,
  AiDisabledError,
  AiNoCredentialsError,
  AiTaskNotAllowedError,
} from "@/lib/ai/facade";
import { AiSpendCapError } from "@/lib/ai/spend";
import { startRun, runStep, completeRun, failRun } from "@/lib/ai/agent-run";
import { createProposal } from "@/lib/ai/proposals";
import type { CoaDraftOutput } from "@/lib/ai/schemas/coa-draft";
import type { CategoryMappingSuggestOutput } from "@/lib/ai/schemas/category-mapping-suggest";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_EXISTING_ACCOUNTS,
  type CoaDraftExistingAccount,
} from "@/lib/ai/prompts/coa-draft";
import type { MappingSuggestRow } from "@/lib/ai/prompts/category-mapping-suggest";
import { sanitizeUntrustedText } from "@/lib/ai/prompts/sanitize";
import { allMappingKeys, mappingRowFor } from "@/lib/coa/mapping-registry";
import type { CoaSnapshot } from "@/lib/coa/plan-preset";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import {
  MAX_DRAFT_ACCOUNTS,
  validateCoaDraft,
  validateMappingSuggestions,
} from "@/lib/coa/validate-draft";
import { parseOrgMetadata } from "@/lib/org-metadata";
import { createLogger } from "@/lib/logger";
import { retryPolicyFor } from "../retry-policy";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.coa-scaffold");

export const COA_SCAFFOLD_JOB_TYPE = "coa_scaffold";

export interface CoaScaffoldJobPayload {
  /** Created by the enqueuing route so a client can poll immediately. */
  runId?: string;
  /** Untrusted free text from onboarding. */
  businessDescription?: string;
}

export function coaScaffoldDedupeKey(orgId: string): string {
  return `coa_scaffold:${orgId}`;
}

/** Configuration failures worth reporting rather than retrying. */
function permanentFailureKind(err: unknown): string | null {
  if (err instanceof AiSpendCapError) return "spend_cap";
  if (err instanceof AiDisabledError) return "ai_disabled";
  if (err instanceof AiTaskNotAllowedError) return "task_not_allowed";
  if (err instanceof AiNoCredentialsError) return "no_credentials";
  return null;
}

/**
 * Mint the per-run key namespace.
 *
 * Keys are "E0".."En", never database IDs — the model is not shown a uuid it
 * could echo somewhere else, and the key set IS the `coaKeys` grounding set
 * passed to `aiComplete`. Ordering is by account number so the namespace is
 * stable for a given chart.
 */
function mintCoaKeys(snapshot: CoaSnapshot): {
  keyToAccountId: Map<string, string>;
  accounts: CoaDraftExistingAccount[];
} {
  const ordered = snapshot.accounts
    .filter((account) => account.isActive)
    .sort((a, b) => {
      const byNumber = (a.accountNumber ?? "~").localeCompare(b.accountNumber ?? "~");
      return byNumber !== 0 ? byNumber : a.id.localeCompare(b.id);
    })
    .slice(0, MAX_EXISTING_ACCOUNTS);

  const keyToAccountId = new Map<string, string>();
  const accounts: CoaDraftExistingAccount[] = ordered.map((account, index) => {
    const key = `E${index}`;
    keyToAccountId.set(key, account.id);
    return {
      key,
      name: account.name,
      accountType: account.accountType,
      subtype: account.subtype,
    };
  });

  return { keyToAccountId, accounts };
}

async function loadOrgIndustry(tx: DbExecutor, orgId: string): Promise<string> {
  const [row] = await tx
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return parseOrgMetadata(row?.metadata).industry ?? "";
}

export async function processCoaScaffoldJob(
  job: ProcessingJob,
  _ctx: JobContext,
): Promise<JobHandlerResult> {
  const orgId = job.organizationId;
  const payload = (job.payload ?? {}) as unknown as CoaScaffoldJobPayload;

  const orgTx = <T>(fn: (tx: DbExecutor) => Promise<T>) =>
    withOrgContext(orgId, "system", "admin", fn);

  const runId =
    payload.runId ?? (await orgTx((tx) => startRun(tx, { orgId, kind: "coa_scaffold" })));
  const run = { runId, orgId, processingJobId: job.id };

  try {
    const context = await orgTx(async (tx) => ({
      snapshot: await loadCoaSnapshot(tx, orgId),
      industry: await loadOrgIndustry(tx, orgId),
    }));

    // Hard precondition: the deterministic preset owns the roots.
    if (context.snapshot.accounts.length === 0) {
      await orgTx((tx) =>
        failRun(
          tx,
          runId,
          {
            kind: "no_chart",
            message:
              "This organization has no chart of accounts yet. Apply a chart-of-accounts preset before drafting additions.",
          },
          orgId,
        ),
      );
      return { processed: true, jobId: job.id, runId, reason: "no_chart" };
    }

    const { keyToAccountId, accounts: existingForPrompt } = mintCoaKeys(context.snapshot);
    const coaKeys = new Set(keyToAccountId.keys());

    // ── Step 1: draft the missing accounts ──────────────────────────────
    let draftProposalId: string | null = null;
    let draftedCount = 0;
    await runStep(db, run, "draft", async () => {
      // The model call must NOT run inside an open transaction.
      const result = await aiComplete<CoaDraftOutput>({
        task: "coa_draft",
        input: {
          businessDescription: sanitizeUntrustedText(
            payload.businessDescription,
            MAX_DESCRIPTION_CHARS,
          ),
          industry: sanitizeUntrustedText(context.industry, 120),
          existingAccounts: existingForPrompt,
          maxAccounts: MAX_DRAFT_ACCOUNTS,
        },
        ctx: { orgId },
        // First caller in the codebase to pass this. A missing set is treated
        // as EMPTY by the façade, which would blank every parentKey.
        allowedIds: { coaKeys },
      });

      if (!result.ok) {
        logger.warn("COA draft failed validation", { orgId, issues: result.issues });
        return { output: { drafted: 0, issues: result.issues.length } };
      }

      const validation = validateCoaDraft(
        result.data.accounts.map((account) => ({
          key: account.key,
          name: account.name,
          accountType: account.accountType,
          subtype: account.subtype,
          parentKey: account.parentKey,
          parentDraftKey: account.parentDraftKey,
          description: account.description,
        })),
        { existing: context.snapshot.accounts, parentKeys: keyToAccountId },
      );
      draftedCount = validation.accounts.length;
      if (draftedCount === 0) {
        return {
          output: { drafted: 0, rejected: validation.rejected.length },
        };
      }

      // ONE batch proposal, not one per account.
      const proposal = await orgTx((tx) =>
        createProposal(tx, {
          orgId,
          kind: "coa_accounts",
          payload: {
            accounts: validation.accounts.map((account) => ({
              key: account.key,
              name: account.name,
              accountType: account.accountType,
              subtype: account.subtype,
              description: account.description,
              accountNumber: account.accountNumber,
              parentAccountId: account.parentAccountId,
              parentDraftKey: account.parentDraftKey,
              adjustments: account.adjustments,
            })),
            excludedKeys: [],
            overrides: [],
            rejected: validation.rejected,
            truncated: validation.truncated,
            notes: result.data.summary,
          },
          invocationId: result.invocationId,
          sourceRef: { entityType: "agent_run", entityId: runId },
        }),
      );
      draftProposalId = proposal.id;

      return {
        output: {
          drafted: draftedCount,
          rejected: validation.rejected.length,
          truncated: validation.truncated,
          proposalId: proposal.id,
        },
      };
    });

    // ── Step 2: posting defaults ────────────────────────────────────────
    let mappingProposalId: string | null = null;
    let suggestedCount = 0;
    await runStep(db, run, "mappings", async () => {
      const accountKeyById = new Map<string, string>();
      for (const [key, id] of keyToAccountId) accountKeyById.set(id, key);

      const currentTargets = new Map(
        context.snapshot.mappings.map((m) => [
          `${m.mappingType}:${m.sourceKey}`,
          m.targetCategoryId,
        ]),
      );

      const rows: MappingSuggestRow[] = [];
      for (const { mappingType, sourceKey } of allMappingKeys()) {
        const row = mappingRowFor(mappingType, sourceKey);
        if (!row) continue;
        const currentId = currentTargets.get(`${mappingType}:${sourceKey}`);
        rows.push({
          mappingType,
          sourceKey,
          label: row.label,
          requiredAccountType: row.ledgerType,
          currentTargetKey: (currentId && accountKeyById.get(currentId)) || "",
        });
      }

      const result = await aiComplete<CategoryMappingSuggestOutput>({
        task: "category_mapping_suggest",
        input: { rows, accounts: existingForPrompt },
        ctx: { orgId },
        allowedIds: { coaKeys },
      });

      if (!result.ok) {
        logger.warn("Mapping suggestions failed validation", { orgId, issues: result.issues });
        return { output: { suggested: 0, issues: result.issues.length } };
      }

      const validation = validateMappingSuggestions(result.data.assignments, {
        targetKeys: keyToAccountId,
        existing: context.snapshot.accounts,
        currentTargets,
      });
      suggestedCount = validation.assignments.length;
      if (suggestedCount === 0) {
        return { output: { suggested: 0, rejected: validation.rejected.length } };
      }

      const proposal = await orgTx((tx) =>
        createProposal(tx, {
          orgId,
          kind: "category_mapping",
          payload: {
            assignments: validation.assignments,
            excludedKeys: [],
            rejected: validation.rejected,
            notes: result.data.summary,
          },
          invocationId: result.invocationId,
          sourceRef: { entityType: "agent_run", entityId: runId },
        }),
      );
      mappingProposalId = proposal.id;

      return {
        output: {
          suggested: suggestedCount,
          rejected: validation.rejected.length,
          proposalId: proposal.id,
        },
      };
    });

    await orgTx((tx) => completeRun(tx, runId));
    return {
      processed: true,
      jobId: job.id,
      runId,
      draftedAccounts: draftedCount,
      mappingSuggestions: suggestedCount,
      accountsProposalId: draftProposalId,
      mappingProposalId,
    };
  } catch (err) {
    const kind = permanentFailureKind(err);
    const message = err instanceof Error ? err.message : String(err);

    if (kind) {
      // Typed and terminal on the FIRST attempt: retrying a spend cap or a
      // missing credential just delays telling the user what is wrong.
      logger.warn("COA scaffold stopped on a configuration failure", { orgId, kind, message });
      await orgTx((tx) => failRun(tx, runId, { kind, message }, orgId)).catch(() => undefined);
      return { processed: true, jobId: job.id, runId, reason: kind };
    }

    logger.error("COA scaffold job failed", { orgId, error: message });
    await orgTx((tx) => failRun(tx, runId, { message }, orgId)).catch(() => undefined);
    throw err;
  }
}

/** Enqueue (or reuse) the scaffold job for an org. */
export async function enqueueCoaScaffoldJob(
  tx: DbExecutor,
  input: { organizationId: string; runId: string; businessDescription?: string },
): Promise<string | null> {
  const [created] = await tx
    .insert(processingJobs)
    .values({
      organizationId: input.organizationId,
      jobType: COA_SCAFFOLD_JOB_TYPE,
      maxAttempts: retryPolicyFor(COA_SCAFFOLD_JOB_TYPE).maxAttempts,
      dedupeKey: coaScaffoldDedupeKey(input.organizationId),
      payload: {
        runId: input.runId,
        ...(input.businessDescription ? { businessDescription: input.businessDescription } : {}),
      } as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  return created?.id ?? null;
}

/** The queued/running scaffold job for an org, if there is one. */
export async function findActiveCoaScaffoldJob(
  tx: DbExecutor,
  orgId: string,
): Promise<{ id: string; runId: string | null } | null> {
  const [existing] = await tx
    .select({ id: processingJobs.id, payload: processingJobs.payload })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.organizationId, orgId),
        eq(processingJobs.dedupeKey, coaScaffoldDedupeKey(orgId)),
        inArray(processingJobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const runId = (existing.payload as { runId?: string } | null)?.runId ?? null;
  return { id: existing.id, runId };
}
