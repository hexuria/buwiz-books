/**
 * Chart-of-Accounts Scaffold Server Functions
 *
 * Two-key model, both keys asserted here: the wrapper gates `aiTask:run`
 * (this spends money on the org's behalf), and the handler re-asserts
 * `account:create` — the permission the resulting proposal will need to be
 * approved. Queuing work whose only possible outcome is an approval the
 * caller can never give is not a useful thing to allow.
 *
 * Nothing in this module writes to `accounts` or `category_mappings`. The job
 * produces PENDING proposals; the appliers do the writing after a human
 * approves them in the review UI.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../../db/schema/accounts";
import { agentRunSteps } from "../../db/schema/ai";
import { processingJobs } from "../../db/schema/inbox";
import { assertRolePermission } from "../../lib/auth-middleware";
import { failRun, getRunStatus, startRun } from "../../lib/ai/agent-run";
import { sanitizeUntrustedText } from "../../lib/ai/prompts/sanitize";
import { MAX_DESCRIPTION_CHARS } from "../../lib/ai/prompts/coa-draft";
import {
  COA_SCAFFOLD_JOB_TYPE,
  enqueueCoaScaffoldJob,
  findActiveCoaScaffoldJob,
} from "../../lib/jobs/handlers/coa-scaffold";
import { triggerWorker } from "../../lib/jobs/trigger";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
} from "../../lib/server-context";

// ============================================================================
// Start
// ============================================================================

const startSchema = z.object({
  /** Untrusted free text; capped and stripped before it is stored. */
  businessDescription: z.string().max(8000).optional(),
});

export interface QueuedCoaScaffold {
  status: "queued";
  runId: string;
  jobId: string;
  /** True when an in-flight run was returned instead of starting a new one. */
  reused: boolean;
}

export const startCoaScaffold = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof startSchema>) => startSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "coa-scaffold:start", limit: 5, windowMs: 300_000 },
      async ({ orgId, db, role }) => {
        assertRolePermission(role, "account", "create");
        const { businessDescription } = startSchema.parse(rawData);

        // Hard precondition, mirrored in the job handler: the deterministic
        // preset owns the 8 roots and the mapping-completeness guarantee.
        const [existing] = await db
          .select({ total: count() })
          .from(accounts)
          .where(eq(accounts.organizationId, orgId));
        if (Number(existing?.total ?? 0) === 0) {
          throw new Error(
            "Apply a chart-of-accounts preset before drafting additions — the AI adds to a chart, it never creates the root accounts.",
          );
        }

        // Reuse an in-flight run rather than opening a second one the dedupe
        // key would leave with no job to advance it.
        const active = await findActiveCoaScaffoldJob(db, orgId);
        if (active?.runId) {
          return {
            status: "queued" as const,
            runId: active.runId,
            jobId: active.id,
            reused: true,
          } satisfies QueuedCoaScaffold;
        }

        const runId = await startRun(db, {
          orgId,
          kind: "coa_scaffold",
          configSnapshot: { trigger: "manual", hasDescription: Boolean(businessDescription) },
        });
        const jobId = await enqueueCoaScaffoldJob(db, {
          organizationId: orgId,
          runId,
          businessDescription: sanitizeUntrustedText(businessDescription, MAX_DESCRIPTION_CHARS),
        });

        if (!jobId) {
          // Lost a race against a concurrent start. Retire the run we just
          // opened so it cannot sit at "running" forever, and return theirs.
          await failRun(db, runId, { kind: "superseded" }, orgId);
          const winner = await findActiveCoaScaffoldJob(db, orgId);
          if (!winner?.runId) {
            throw new Error("A chart-of-accounts draft is already in progress for this org.");
          }
          return {
            status: "queued" as const,
            runId: winner.runId,
            jobId: winner.id,
            reused: true,
          } satisfies QueuedCoaScaffold;
        }

        return {
          status: "queued" as const,
          runId,
          jobId,
          reused: false,
        } satisfies QueuedCoaScaffold;
      },
    );

    // Only after the enqueue transaction committed.
    if (!outcome.reused) triggerWorker([COA_SCAFFOLD_JOB_TYPE]);
    return outcome;
  });

// ============================================================================
// Status
// ============================================================================

const statusSchema = z.object({
  runId: z.string().uuid(),
  /** Optional: attaches the underlying job's retry state. */
  jobId: z.string().uuid().optional(),
});

/** Retry state of the processing_jobs row behind a run. */
export interface CoaScaffoldJobState {
  status: "queued" | "retrying" | "running" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  nextRunAt: string | null;
  lastError: string | null;
}

export interface CoaScaffoldStatus {
  runId: string;
  status: string;
  blockedReason: Record<string, unknown> | null;
  steps: Array<{ step: string; status: string; error: Record<string, unknown> | null }>;
  counts: {
    draftedAccounts: number | null;
    mappingSuggestions: number | null;
  };
  proposals: {
    accounts: string | null;
    mappings: string | null;
  };
  job?: CoaScaffoldJobState;
}

/** Poll target for the client while the scaffold runs. */
export const getCoaScaffoldStatus = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof statusSchema>) => statusSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("aiTask", "view", async ({ orgId, db }) => {
      const { runId, jobId } = statusSchema.parse(rawData);
      const run = await getRunStatus(db, orgId, runId);
      if (!run) throw new Error("Chart-of-accounts scaffold run not found");

      // Org-scoped primary-key lookup; deriving it from the run would mean
      // scanning processing_jobs on payload->>'runId' with no index.
      let job: CoaScaffoldJobState | undefined;
      if (jobId) {
        const [row] = await db
          .select({
            status: processingJobs.status,
            attempts: processingJobs.attempts,
            maxAttempts: processingJobs.maxAttempts,
            runAt: processingJobs.runAt,
            lastError: processingJobs.lastError,
          })
          .from(processingJobs)
          .where(and(eq(processingJobs.id, jobId), eq(processingJobs.organizationId, orgId)))
          .limit(1);
        if (row) {
          const retrying = row.status === "queued" && row.attempts > 0;
          job = {
            status: retrying ? "retrying" : (row.status as CoaScaffoldJobState["status"]),
            attempt: row.attempts,
            maxAttempts: row.maxAttempts,
            nextRunAt: retrying && row.runAt ? row.runAt.toISOString() : null,
            lastError: row.lastError ?? null,
          };
        }
      }

      const steps = await db
        .select({ step: agentRunSteps.step, outputRef: agentRunSteps.outputRef })
        .from(agentRunSteps)
        .where(and(eq(agentRunSteps.runId, runId), eq(agentRunSteps.organizationId, orgId)));
      const outputs = new Map(steps.map((row) => [row.step, row.outputRef ?? {}]));
      const number = (step: string, key: string): number | null => {
        const value = outputs.get(step)?.[key];
        return typeof value === "number" ? value : null;
      };
      const text = (step: string, key: string): string | null => {
        const value = outputs.get(step)?.[key];
        return typeof value === "string" ? value : null;
      };

      return {
        runId: run.runId,
        status: run.status,
        blockedReason: run.blockedReason,
        steps: run.steps,
        counts: {
          draftedAccounts: number("draft", "drafted"),
          mappingSuggestions: number("mappings", "suggested"),
        },
        proposals: {
          accounts: text("draft", "proposalId"),
          mappings: text("mappings", "proposalId"),
        },
        ...(job ? { job } : {}),
      } satisfies CoaScaffoldStatus;
    }) as any;
  });
