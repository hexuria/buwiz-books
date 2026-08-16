// ============================================================================
// Curate eval cases from production feedback.
//
//   ai_run_feedback (corrections = ground truth) + ai_action_proposals
//     → ai_eval_cases (org-scoped)
//     → tests/evals/datasets/<task>.jsonl (ONLY for consenting orgs)
//
// Consent rule (§8): a case may only join the cross-org golden set when the
// source org has set evalDataSharing = 'global'. Anonymization is necessary
// but NOT sufficient — the filter is on consent, not on redaction.
//
// Usage:
//   bun run scripts/build-eval-dataset.ts             # write org-scoped cases
//   bun run scripts/build-eval-dataset.ts --export    # also write JSONL
// ============================================================================

import { mkdir, writeFile } from "node:fs/promises";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../src/db";
import {
  aiActionProposals,
  aiEvalCases,
  aiRunFeedback,
  organizationAiSettings,
} from "../src/db/schema/ai";
import { redactPII } from "../src/lib/ai/redact";

const shouldExport = process.argv.includes("--export");
const DATASET_DIR = new URL("../tests/evals/datasets/", import.meta.url);

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactPII(value).text;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    );
  }
  return value;
}

async function main() {
  // Corrections are the highest-signal label: a human told us the right answer.
  const corrections = await db
    .select({
      feedbackId: aiRunFeedback.id,
      orgId: aiRunFeedback.organizationId,
      verdict: aiRunFeedback.verdict,
      correction: aiRunFeedback.correction,
      kind: aiActionProposals.kind,
      proposal: aiActionProposals.proposal,
    })
    .from(aiRunFeedback)
    .innerJoin(aiActionProposals, eq(aiRunFeedback.proposalId, aiActionProposals.id))
    .where(
      and(
        inArray(aiRunFeedback.verdict, ["corrected", "accepted"]),
        isNotNull(aiRunFeedback.proposalId),
      ),
    );

  if (corrections.length === 0) {
    console.log("No feedback to curate yet — the flywheel needs review activity first.");
    return;
  }

  // Consent lookup, once.
  const consentRows = await db
    .select({
      organizationId: organizationAiSettings.organizationId,
      evalDataSharing: organizationAiSettings.evalDataSharing,
      evalConsentAt: organizationAiSettings.evalConsentAt,
    })
    .from(organizationAiSettings);
  const consented = new Map(
    consentRows
      .filter((r) => r.evalDataSharing === "global")
      .map((r) => [r.organizationId, r.evalConsentAt]),
  );

  let inserted = 0;
  const exportable: Array<{ task: string; line: string }> = [];

  for (const row of corrections) {
    // For "corrected", the user's value IS the expected output; for
    // "accepted", the proposal itself was right.
    const expected = row.verdict === "corrected" && row.correction ? row.correction : row.proposal;

    const input = redactDeep(row.proposal) as Record<string, unknown>;
    const consentAt = consented.get(row.orgId) ?? null;

    await db
      .insert(aiEvalCases)
      .values({
        organizationId: row.orgId,
        task: row.kind,
        inputRef: input,
        expected: redactDeep(expected) as Record<string, unknown>,
        provenance: "curated_from_feedback",
        piiRedacted: true,
        orgConsentAt: consentAt,
      })
      .onConflictDoNothing();
    inserted++;

    if (consentAt) {
      exportable.push({
        task: row.kind,
        line: JSON.stringify({ task: row.kind, input, expected }),
      });
    }
  }

  console.log(`Curated ${inserted} org-scoped eval case(s).`);
  console.log(
    `${exportable.length} case(s) come from consenting orgs and may join the golden set.`,
  );

  if (shouldExport && exportable.length > 0) {
    await mkdir(DATASET_DIR, { recursive: true });
    const byTask = new Map<string, string[]>();
    for (const item of exportable) {
      const bucket = byTask.get(item.task) ?? [];
      bucket.push(item.line);
      byTask.set(item.task, bucket);
    }
    for (const [task, lines] of byTask) {
      const file = new URL(`${task}.jsonl`, DATASET_DIR);
      await writeFile(file, `${lines.join("\n")}\n`, "utf8");
      console.log(`  wrote ${lines.length} case(s) → tests/evals/datasets/${task}.jsonl`);
    }
  } else if (shouldExport) {
    console.log("Nothing to export: no org has opted in to cross-org eval sharing.");
  }
}

await main();
