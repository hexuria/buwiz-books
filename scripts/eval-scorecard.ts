/**
 * bun eval:scorecard — replay a pile of papers under a rule set and print the
 * metrics (Inbox v2 spec §9).
 *
 *   bun eval:scorecard --pile golden --json
 *   bun eval:scorecard --pile tests/evals/scorecard/golden.jsonl --rules default
 *   bun eval:scorecard --pile golden --rules <snapshot-id> --org <orgId>
 *   bun eval:scorecard --pile org:<orgId> --rules live --limit 500
 *
 * Recorded mode only: nothing calls a model, so a file pile with file or
 * default rules needs no network and no database — the database module is not
 * even loaded on that path. Organization piles, live rules, and snapshots are
 * read inside the organization's context (withOrgContext, as background code
 * does) in a READ ONLY transaction, after printing which database answered.
 *
 * Exit codes: 0 report printed; 1 runtime failure; 2 bad arguments or input.
 * A failing locked case does not change the exit code — the CI gate for that
 * is tests/evals/scorecard.eval.ts.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuleSnapshotEntry } from "../src/db/schema/rule-snapshots";
import { DEFAULT_BOOK_RULE_FALLBACKS, type BookRuleFallbacks } from "../src/lib/inbox/rule-set";
import {
  catalogDefaultRuleEntries,
  formatScorecardReport,
  parseRuleSetFile,
  parseScorecardArgs,
  parseScorecardPile,
  runScorecard,
  SCORECARD_USAGE,
  ScorecardInputError,
  type ScorecardArgs,
  type ScorecardCase,
} from "../src/lib/inbox/scorecard";

interface LoadedInputs {
  cases: ScorecardCase[];
  entries: RuleSnapshotEntry[];
  fallbacks: BookRuleFallbacks;
  pileLabel: string;
  rulesLabel: string;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(resolve(process.cwd(), path), "utf8");
  } catch (error) {
    throw new ScorecardInputError(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

function needsDatabase(args: ScorecardArgs): boolean {
  return args.pile.kind === "org" || args.rules.kind === "live" || args.rules.kind === "snapshot";
}

/** Everything a database-free run needs: a pile file plus a rules file or the defaults. */
async function loadFileInputs(args: ScorecardArgs): Promise<Partial<LoadedInputs>> {
  const loaded: Partial<LoadedInputs> = {};
  if (args.pile.kind === "file") {
    loaded.cases = parseScorecardPile(await readText(args.pile.path), args.pile.path);
    loaded.pileLabel = args.pile.path;
  }
  if (args.rules.kind === "default") {
    loaded.entries = catalogDefaultRuleEntries();
    loaded.fallbacks = DEFAULT_BOOK_RULE_FALLBACKS;
    loaded.rulesLabel = "default (catalog defaults)";
  } else if (args.rules.kind === "file") {
    const file = parseRuleSetFile(await readText(args.rules.path), args.rules.path);
    loaded.entries = file.entries;
    loaded.fallbacks = DEFAULT_BOOK_RULE_FALLBACKS;
    loaded.rulesLabel = file.label ? `${args.rules.path} (${file.label})` : args.rules.path;
  }
  return loaded;
}

async function loadDatabaseInputs(
  args: ScorecardArgs,
  loaded: Partial<LoadedInputs>,
): Promise<LoadedInputs> {
  const orgId = args.orgId!;
  // Loaded lazily so the database-free path never opens a client.
  const [{ withOrgContext }, { sql }, snapshots, orgPile] = await Promise.all([
    import("../src/db"),
    import("drizzle-orm"),
    import("../src/lib/inbox/rule-snapshots"),
    import("../src/lib/inbox/scorecard-org-pile"),
  ]);
  return withOrgContext(orgId, "system", "admin", async (tx) => {
    // The scorecard only reads; make the database hold it to that.
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [target] = (await tx.execute(
      sql`SELECT current_database() AS db, current_user AS usr`,
    )) as unknown as Array<{ db: string; usr: string }>;
    console.error(`🔌 ${target?.db} as ${target?.usr} · organization ${orgId}`);

    const result = { ...loaded } as LoadedInputs;
    if (args.pile.kind === "org") {
      const pile = await orgPile.loadOrgScorecardPile(tx, orgId, {
        limit: args.limit ?? undefined,
      });
      if (pile.cases.length === 0) {
        throw new ScorecardInputError(
          `Organization ${orgId} has no decided Inbox items with posting lines to replay.`,
        );
      }
      if (pile.skipped > 0) {
        console.error(
          `   skipped ${pile.skipped} decided item(s) with fewer than two posting lines`,
        );
      }
      result.cases = pile.cases;
      result.pileLabel = `org:${orgId}`;
    }
    if (args.rules.kind === "live") {
      result.entries = await snapshots.buildLiveRuleSnapshotEntries(tx, orgId);
      result.fallbacks = await snapshots.loadRuleFallbacks(tx, orgId);
      result.rulesLabel = `live (org ${orgId})`;
    } else if (args.rules.kind === "snapshot") {
      const snapshot = await snapshots.getRuleSnapshot(tx, orgId, args.rules.snapshotId);
      result.entries = snapshot.snapshot;
      result.fallbacks = await snapshots.loadRuleFallbacks(tx, orgId);
      result.rulesLabel = snapshot.label
        ? `snapshot ${snapshot.id} (${snapshot.label})`
        : `snapshot ${snapshot.id}`;
    }
    return result;
  });
}

async function main(): Promise<number> {
  const args = parseScorecardArgs(process.argv.slice(2));
  if (args.help) {
    console.log(SCORECARD_USAGE);
    return 0;
  }
  const fileInputs = await loadFileInputs(args);
  const inputs = needsDatabase(args)
    ? await loadDatabaseInputs(args, fileInputs)
    : (fileInputs as LoadedInputs);
  const { report } = runScorecard({
    cases: inputs.cases,
    entries: inputs.entries,
    fallbacks: inputs.fallbacks,
    pile: inputs.pileLabel,
    rules: inputs.rulesLabel,
    chain: args.chain,
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatScorecardReport(report));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof ScorecardInputError) {
      console.error(`eval:scorecard: ${error.message}\n\n${SCORECARD_USAGE}`);
      process.exit(2);
    }
    console.error("eval:scorecard failed:", error);
    process.exit(1);
  });
