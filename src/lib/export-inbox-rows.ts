/**
 * Inbox v2 organization configuration in the versioned export (v5): the wire rows, their
 * validators, and the pure decisions an import makes about each row. The database half — the
 * SELECTs, the inserts, the reference lookups — is ./export-inbox.ts.
 *
 * Three entities, imported in this order (each resolves against the one before):
 *
 *   ruleSnapshots          immutable rule packs. The row keeps its source `id` (the file's name
 *                          for it), its `label`, its content, and its creation time to the
 *                          microsecond. (createdAt, label) is its natural key.
 *   routines               how papers get in. Pins travel as { id, label, createdAt } of the
 *                          pinned snapshot and are remapped onto the snapshot imported from it.
 *   classificationMemories human fixes that stick. Parties travel by name and accounts by
 *                          (number, name) — the same resolvable references the rest of the export
 *                          uses — and are remapped on import.
 *
 * Never exported: `routine_secrets` (a webhook routine's signing secret, nor even its
 * `secret_ref`), runtime state (cursor, next/last run, last error), user ids, and anything the
 * memories learned from (`ai_run_feedback`, eval cases, documents). Ids never cross databases.
 */
import { z } from "zod";
import { ruleSnapshotEntriesSchema } from "@/lib/inbox/rule-set";
import {
  MEMORY_DOC_KINDS,
  memoryAnswerLineSchema,
  memoryAnswerSchema,
  type MemoryAnswer,
  type MemoryAnswerLine,
} from "@/lib/inbox/memory/answer";
import {
  MATCH_KEY_MAX_CHARS,
  MEMORY_MATCH_KINDS,
  fileHashKey,
  partyKey,
  type MemoryMatchKind,
} from "@/lib/inbox/memory/keys";
import {
  HMAC_WEBHOOK_PROVIDER,
  INBOUND_EMAIL_PROVIDER,
  ROUTINE_NAME_MAX_LENGTH,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_TOLERANCE_SECONDS,
  defaultHmacWebhookConfig,
  inboundEmailTriggerConfig,
  parseHmacWebhookConfig,
  parseScheduleTriggerConfig,
} from "@/lib/routines/config";
import { computeNextRunAt } from "@/lib/routines/schedule";
import { getScheduleSource } from "@/lib/routines/schedule-sources";

/** Import order matters: snapshots before the routines that pin them. */
export const INBOX_CONFIG_ENTITY_KEYS = [
  "ruleSnapshots",
  "routines",
  "classificationMemories",
  // TODO(inbox-v2 step 11): "aiAutonomyLanes" joins here — see the block in ./export-inbox.ts.
] as const;

export type InboxConfigEntityKey = (typeof INBOX_CONFIG_ENTITY_KEYS)[number];

export function isInboxConfigEntity(value: string): value is InboxConfigEntityKey {
  return (INBOX_CONFIG_ENTITY_KEYS as readonly string[]).includes(value);
}

/** One row's outcome, in the shape every executeImport entity reports. */
export interface InboxConfigImportResult {
  name: string;
  success: boolean;
  error?: string;
}

/** The ImportPanel counts a success whose note mentions "skipped" as skipped. */
export const DUPLICATE_SKIPPED = "Duplicate (skipped)";

/**
 * An exact UTC timestamp: the export writes microseconds (Postgres precision) so a snapshot's
 * creation time survives the round trip exactly and can identify it again.
 */
const exactTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u,
    "must be a UTC timestamp like 2026-09-27T10:15:00.123456Z",
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a real date and time");

// ============================================================================
// Rule snapshots
// ============================================================================

/** RULE_SNAPSHOT_LABEL_MAX_LENGTH in src/lib/inbox/rule-snapshots.ts (a unit test keeps them equal). */
export const IMPORTED_SNAPSHOT_LABEL_MAX_LENGTH = 120;

export const ruleSnapshotExportRowSchema = z.object({
  /** The snapshot's id where it was exported: how routine pins in the same file name it. */
  id: z.string().uuid(),
  label: z.string().max(IMPORTED_SNAPSHOT_LABEL_MAX_LENGTH).nullable().default(null),
  snapshot: ruleSnapshotEntriesSchema.refine(
    (entries) => entries.length > 0,
    "A rule snapshot holds at least one rule.",
  ),
  createdAt: exactTimestamp,
});

export type RuleSnapshotExportRow = z.output<typeof ruleSnapshotExportRowSchema>;

export function describeSnapshotRow(row: { label: string | null; createdAt: string }): string {
  return `${row.label ?? "Untitled snapshot"} (${row.createdAt})`;
}

// ============================================================================
// Routines
// ============================================================================

/** A routine's pin: enough of the pinned snapshot to find it again after it is imported. */
export const ruleSnapshotReferenceSchema = z.object({
  id: z.string().uuid(),
  label: z.string().nullable(),
  createdAt: exactTimestamp,
});

export type RuleSnapshotReference = z.output<typeof ruleSnapshotReferenceSchema>;

export const routineExportRowSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(ROUTINE_NAME_MAX_LENGTH),
  enabled: z.boolean(),
  triggerKind: z.enum(["webhook", "schedule", "integration"]),
  triggerConfig: z.record(z.string(), z.unknown()),
  maxConcurrentRuns: z.number().int().min(1).default(1),
  ruleSnapshot: ruleSnapshotReferenceSchema.nullable().default(null),
  shadowRuleSnapshot: ruleSnapshotReferenceSchema.nullable().default(null),
});

export type RoutineExportRow = z.output<typeof routineExportRowSchema>;

/**
 * A routine's trigger config as exported: everything but `secret_ref`. The reference names a
 * `routine_secrets` row; the secret never leaves the database, and a reference to it means
 * nothing anywhere else.
 */
export function exportTriggerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { secret_ref: _secretRef, ...rest } = config;
  return rest;
}

export const IMPORTED_WEBHOOK_NOTE =
  "Imported disabled without its signing secret: generate a new secret, then enable the routine.";
export const IMPORTED_WITHOUT_CHART_NOTE =
  "Imported disabled: set up the chart of accounts, then enable the routine.";

export interface RoutineImportValues {
  name: string;
  enabled: boolean;
  triggerKind: RoutineExportRow["triggerKind"];
  triggerConfig: Record<string, unknown>;
  maxConcurrentRuns: number;
  nextRunAt: Date | null;
}

export type RoutineImportPlan =
  | { ok: false; message: string }
  | {
      ok: true;
      /** The organization's one inbound email routine: never duplicated. */
      inboundEmail: boolean;
      values: RoutineImportValues;
      /** Why the routine arrives disabled, and what makes it runnable. */
      note: string | null;
    };

/**
 * What an exported routine becomes in this organization, before its pins are resolved.
 *
 *   • The trigger config is rebuilt from what the app accepts, never copied: a file cannot
 *     smuggle a `secret_ref` (it is always null) or keys the routine code does not read.
 *   • A signed webhook arrives with no secret, so it arrives disabled with a note to generate one.
 *   • Enabling needs an applied chart (spec §3); an enabled schedule imported into an organization
 *     without one arrives disabled with a note. The inbound email routine keeps its exported
 *     state: like its provisioning by the first email, it is exempt from the chart gate.
 *   • Integration routines cannot be imported: their connection is not part of the export.
 */
export function planRoutineImport(
  row: RoutineExportRow,
  context: { chartApplied: boolean; now: Date },
): RoutineImportPlan {
  if (
    row.ruleSnapshot &&
    row.shadowRuleSnapshot &&
    row.ruleSnapshot.id === row.shadowRuleSnapshot.id
  ) {
    return { ok: false, message: "A routine cannot shadow the rule snapshot it enforces." };
  }
  const base = { name: row.name, maxConcurrentRuns: row.maxConcurrentRuns };

  if (row.triggerKind === "integration") {
    return {
      ok: false,
      message:
        "Integration routines cannot be imported: their connection is not part of the export.",
    };
  }

  if (row.triggerKind === "webhook") {
    const provider = row.triggerConfig.provider;
    if (provider === INBOUND_EMAIL_PROVIDER) {
      return {
        ok: true,
        inboundEmail: true,
        values: {
          ...base,
          enabled: row.enabled,
          triggerKind: "webhook",
          triggerConfig: { ...inboundEmailTriggerConfig() },
          nextRunAt: null,
        },
        note: null,
      };
    }
    if (provider !== HMAC_WEBHOOK_PROVIDER) {
      return { ok: false, message: `Unknown webhook provider "${String(provider)}".` };
    }
    const hmac = parseHmacWebhookConfig({ ...row.triggerConfig, secret_ref: null });
    if (!hmac) return { ok: false, message: "The webhook's settings are not valid." };
    if (hmac.tolerance_s > WEBHOOK_TOLERANCE_SECONDS || hmac.max_bytes > WEBHOOK_MAX_BODY_BYTES) {
      return {
        ok: false,
        message: `A webhook may only tighten the ${WEBHOOK_TOLERANCE_SECONDS}-second tolerance and ${WEBHOOK_MAX_BODY_BYTES}-byte body limits.`,
      };
    }
    return {
      ok: true,
      inboundEmail: false,
      values: {
        ...base,
        enabled: false,
        triggerKind: "webhook",
        triggerConfig: {
          ...defaultHmacWebhookConfig(),
          tolerance_s: hmac.tolerance_s,
          max_bytes: hmac.max_bytes,
        },
        nextRunAt: null,
      },
      note: IMPORTED_WEBHOOK_NOTE,
    };
  }

  const schedule = parseScheduleTriggerConfig(row.triggerConfig);
  if (!schedule) return { ok: false, message: "The routine's schedule is not valid." };
  if (!getScheduleSource(schedule.source)) {
    return { ok: false, message: `Unknown schedule source "${schedule.source}".` };
  }
  const enabled = row.enabled && context.chartApplied;
  return {
    ok: true,
    inboundEmail: false,
    values: {
      ...base,
      enabled,
      triggerKind: "schedule",
      triggerConfig: {
        preset: schedule.preset,
        at: schedule.at,
        weekday: schedule.weekday,
        timezone: schedule.timezone,
        source: schedule.source,
      },
      // Enabling a schedule computes its next slot, exactly as enabling it in the app does.
      nextRunAt: enabled ? computeNextRunAt(schedule, context.now) : null,
    },
    note: row.enabled && !enabled ? IMPORTED_WITHOUT_CHART_NOTE : null,
  };
}

// ============================================================================
// Classification memories
// ============================================================================

/**
 * An exact, positive decimal with at most 8 places, checked by pattern alone. (The app's own
 * answer schema parses the value inside its refinement, which throws on a malformed string
 * instead of failing validation; a file is untrusted input, so its amounts are checked here first.)
 */
const exactPositiveDecimal = z
  .string()
  .regex(/^\d+(?:\.\d{1,8})?$/u, "must be a decimal with at most 8 places")
  .refine((value) => !/^0*(?:\.0*)?$/u.test(value), "must be greater than zero");

/** A remembered line as exported: the account by (number, name) instead of its id. */
export const memoryAnswerLineExportSchema = memoryAnswerLineSchema
  .omit({ accountId: true })
  .extend({
    amount: exactPositiveDecimal,
    accountNumber: z.string().min(1).nullable().default(null),
    accountName: z.string().min(1).nullable().default(null),
  });

export type MemoryAnswerLineExport = z.output<typeof memoryAnswerLineExportSchema>;

export const classificationMemoryExportRowSchema = z
  .object({
    matchKind: z.enum(MEMORY_MATCH_KINDS),
    /** The normalized key. Null for a `party` memory: its key is a party id, exported by name. */
    matchKey: z.string().min(1).max(MATCH_KEY_MAX_CHARS).nullable().default(null),
    /** A `party` memory's party, by name. */
    matchPartyName: z.string().min(1).nullable().default(null),
    answerDocKind: z.enum(MEMORY_DOC_KINDS),
    answerPartyName: z.string().min(1).nullable().default(null),
    answerLines: z.array(memoryAnswerLineExportSchema).min(2).max(100),
    uses: z.number().int().min(0).default(0),
    undos: z.number().int().min(0).default(0),
    consecutiveUndos: z.number().int().min(0).default(0),
    enabled: z.boolean().default(true),
  })
  .superRefine((row, ctx) => {
    if (row.matchKind !== "party" && !row.matchKey) {
      ctx.addIssue({ code: "custom", path: ["matchKey"], message: "A match key is required." });
    }
    if (
      row.matchKind === "file_hash" &&
      row.matchKey &&
      fileHashKey(row.matchKey) !== row.matchKey
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["matchKey"],
        message: "A file memory's key is the file's sha256 digest (64 lower-case hex digits).",
      });
    }
    if (row.matchKind === "line_text" && row.answerPartyName) {
      // "These words" match any party's paper, so such a memory never pins one (as saved).
      ctx.addIssue({
        code: "custom",
        path: ["answerPartyName"],
        message: 'A "these words" memory never names a party.',
      });
    }
  });

export type ClassificationMemoryExportRow = z.output<typeof classificationMemoryExportRowSchema>;

/** What the import resolves references against: this organization's chart and parties. */
export interface ChartAccountRef {
  id: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  isActive: boolean;
}

export interface PartyRef {
  id: string;
  name: string;
}

type Resolution<T> = { ok: true; value: T } | { ok: false; problem: string };

function accountLabel(ref: { accountNumber: string | null; accountName: string | null }): string {
  if (ref.accountNumber && ref.accountName) return `${ref.accountNumber} "${ref.accountName}"`;
  if (ref.accountNumber) return ref.accountNumber;
  return ref.accountName ? `"${ref.accountName}"` : "(unnamed)";
}

/**
 * The account an exported reference names in this chart: by number first, then by name — the
 * import's resolvable-pair rule for every entity. A retired (inactive) account is not a mapping,
 * and neither is a name several accounts share.
 */
export function resolveAccountReference(
  chart: readonly ChartAccountRef[],
  ref: { accountNumber: string | null; accountName: string | null },
): Resolution<ChartAccountRef> {
  if (!ref.accountNumber && !ref.accountName) {
    return { ok: false, problem: "an account in the answer no longer exists" };
  }
  let found = ref.accountNumber
    ? chart.find((account) => account.accountNumber === ref.accountNumber)
    : undefined;
  if (!found && ref.accountName) {
    const byName = chart.filter((account) => account.name === ref.accountName);
    if (byName.length > 1) {
      return {
        ok: false,
        problem: `account ${accountLabel(ref)} matches ${byName.length} accounts here`,
      };
    }
    found = byName[0];
  }
  if (!found) return { ok: false, problem: `account ${accountLabel(ref)} is not in this chart` };
  if (!found.isActive) return { ok: false, problem: `account ${accountLabel(ref)} is inactive` };
  return { ok: true, value: found };
}

/** The party an exported name names here; a name several parties share maps to none of them. */
export function resolvePartyReference(
  parties: readonly PartyRef[],
  name: string,
): Resolution<PartyRef> {
  const matches = parties.filter((party) => party.name === name);
  if (matches.length === 0) return { ok: false, problem: `party "${name}" is not here` };
  if (matches.length > 1) {
    return { ok: false, problem: `party "${name}" matches ${matches.length} parties here` };
  }
  return { ok: true, value: matches[0] };
}

export interface MemoryImportValues {
  matchKind: MemoryMatchKind;
  matchKey: string;
  answerDocKind: MemoryAnswer["docKind"];
  answerPartyId: string | null;
  answerLines: MemoryAnswerLine[];
  uses: number;
  undos: number;
  consecutiveUndos: number;
  enabled: boolean;
}

export type MemoryImportPlan =
  | { ok: true; values: MemoryImportValues }
  | { ok: false; dropped: true; message: string }
  | { ok: false; dropped: false; message: string };

/**
 * What an exported memory becomes here. Every party and account it references is remapped
 * through this organization's own chart and parties; if any cannot be, the memory is DROPPED and
 * the reason reported — a memory pointing somewhere else would answer papers wrongly, and one
 * pointing nowhere would never answer at all. An account that exists here as a different kind
 * (the memory was saved for an expense account, the name now belongs to a liability) is not a
 * mapping either: the memory would be refused at every lookup.
 */
export function planMemoryImport(
  row: ClassificationMemoryExportRow,
  refs: { chart: readonly ChartAccountRef[]; parties: readonly PartyRef[] },
): MemoryImportPlan {
  const drop = (problem: string): MemoryImportPlan => ({
    ok: false,
    dropped: true,
    message: `Dropped: ${problem}.`,
  });

  let matchKey = row.matchKey;
  if (row.matchKind === "party") {
    if (!row.matchPartyName) return drop("the party this memory matches no longer exists");
    const party = resolvePartyReference(refs.parties, row.matchPartyName);
    if (!party.ok) return drop(party.problem);
    matchKey = partyKey(party.value.id);
  }
  if (!matchKey) return { ok: false, dropped: false, message: "A match key is required." };

  let answerPartyId: string | null = null;
  if (row.answerPartyName) {
    const party = resolvePartyReference(refs.parties, row.answerPartyName);
    if (!party.ok) return drop(party.problem);
    answerPartyId = party.value.id;
  }

  const lines: MemoryAnswerLine[] = [];
  for (const line of row.answerLines) {
    const account = resolveAccountReference(refs.chart, line);
    if (!account.ok) return drop(account.problem);
    if (account.value.accountType !== line.accountType) {
      return drop(
        `account ${accountLabel(line)} is ${account.value.accountType} here, but the memory was saved for ${line.accountType}`,
      );
    }
    lines.push({
      lineMatch: line.lineMatch,
      accountId: account.value.id,
      accountType: line.accountType,
      amount: line.amount,
      currency: line.currency,
      taxCode: line.taxCode,
    });
  }

  // The answer must be one the app itself would store.
  const answer = memoryAnswerSchema.safeParse({
    docKind: row.answerDocKind,
    partyId: answerPartyId,
    lines,
  });
  if (!answer.success) {
    return {
      ok: false,
      dropped: false,
      message: `The remembered answer is not valid: ${answer.error.issues[0]?.message ?? "unknown"}.`,
    };
  }

  return {
    ok: true,
    values: {
      matchKind: row.matchKind,
      matchKey,
      answerDocKind: answer.data.docKind,
      answerPartyId: answer.data.partyId,
      answerLines: answer.data.lines,
      uses: row.uses,
      undos: row.undos,
      consecutiveUndos: row.consecutiveUndos,
      enabled: row.enabled,
    },
  };
}

/** The row validator validateImport and executeImport apply to an entity's rows. */
export function inboxConfigRowSchema(entity: InboxConfigEntityKey) {
  switch (entity) {
    case "ruleSnapshots":
      return ruleSnapshotExportRowSchema;
    case "routines":
      return routineExportRowSchema;
    case "classificationMemories":
      return classificationMemoryExportRowSchema;
  }
}

/** A readable name for a memory row in import results. */
export function describeMemoryRow(row: ClassificationMemoryExportRow): string {
  const subject =
    row.matchKind === "party"
      ? (row.matchPartyName ?? "a deleted party")
      : row.matchKind === "file_hash"
        ? `file ${row.matchKey?.slice(0, 12) ?? ""}…`
        : (row.matchKey ?? "");
  return `${row.matchKind}: ${subject}`;
}
