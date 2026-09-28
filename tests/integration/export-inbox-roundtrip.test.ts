// ============================================================================
// Export v5 round trip (Inbox v2 step 12): an organization's routines, rule
// snapshots (one pinned, one shadowed), classification memories and Jev
// approval lanes leave through Settings → Export and arrive in a FRESH
// organization through Settings → Import — equal to what was exported except
// for the ids, which are remapped. No signing secret leaves; imported signed
// webhooks start disabled; a memory or lane whose party or account cannot be
// mapped is dropped and reported; every lane arrives at watch, with neither
// its labels nor the organization's Jev-approval switch; re-importing changes
// nothing; the per-org inbound email routine is never duplicated.
//
// The real server functions run (exportData → JSON text → validateImport →
// executeImport), behind a reduced request exactly as in
// review-rule-settings.test.ts: TanStack Start's plumbing and better-auth's
// cookie lookup are stood in for, and the caller's role is read live from
// auth_members.
// ============================================================================
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

const caller = vi.hoisted(() => ({ userId: "", orgId: "" }));

vi.mock("@tanstack/react-start", () => {
  type Validator = (input: unknown) => unknown;
  type Handler = (opts: { data: unknown }) => unknown;
  const builder = (validate?: Validator) => ({
    inputValidator: (next: Validator) => builder(next),
    handler: (fn: Handler) => async (opts?: { data?: unknown }) =>
      fn({ data: validate ? validate(opts?.data) : opts?.data }),
  });
  return { createServerFn: () => builder() };
});

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("http://localhost:3001/_serverFn/export-import", { method: "POST" }),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: caller.userId },
        session: { activeOrganizationId: caller.orgId },
      })),
      setActiveOrganization: vi.fn(),
    },
  },
}));

import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { activityLogs } from "@/db/schema/activity-logs";
import { aiAutonomyLanes, aiRunFeedback, organizationAiSettings } from "@/db/schema/ai";
import { member, organization, user } from "@/db/schema/auth";
import { classificationMemories } from "@/db/schema/classification-memories";
import { parties } from "@/db/schema/parties";
import { routineSecrets, routines } from "@/db/schema/routines";
import { ruleSnapshots } from "@/db/schema/rule-snapshots";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import {
  DUPLICATE_SKIPPED,
  IMPORTED_WEBHOOK_NOTE,
  importedLaneNote,
} from "@/lib/export-inbox-rows";
import { loadJevApprovalSettings } from "@/lib/inbox/jev-approval/settings";
import {
  createRoutine,
  ensureInboundEmailRoutine,
  rotateRoutineWebhookSecret,
  setRoutineRuleSnapshot,
} from "@/lib/routines/service";

const integrationDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type ImportResult = {
  imported: number;
  skipped: number;
  failed: number;
  results: Array<{ name: string; success: boolean; error?: string }>;
};
type ValidationResult = {
  invalid: number;
  rows: Array<{ valid: boolean; data?: Record<string, unknown>; errors?: string[] }>;
};
type ExportFile = { meta: { version: number }; data: Record<string, unknown> };

// Imported after the mocks so the module is built with them. Called the way the Settings panels
// call them: one `{ data }` argument.
const route = await import("@/routes/api/-export-import");
const api = {
  exportData: route.exportData as unknown as (opts: { data: unknown }) => Promise<ExportFile>,
  validateImport: route.validateImport as unknown as (opts: {
    data: unknown;
  }) => Promise<ValidationResult>,
  executeImport: route.executeImport as unknown as (opts: {
    data: unknown;
  }) => Promise<ImportResult>,
};

const INBOX_ENTITIES = [
  "ruleSnapshots",
  "routines",
  "classificationMemories",
  "aiAutonomyLanes",
] as const;
type InboxEntity = (typeof INBOX_ENTITIES)[number];

const HOSTING = "Roundtrip Hosting";
const SOURCE_ONLY_VENDOR = "Source Only Vendor";
const SOURCE_ONLY_ACCOUNT = { name: "Source Only Expense", accountNumber: "69990" };
const FILE_HASH = "ab".repeat(32);
/** Written into a lane label's evidence: it must never appear in the file. */
const LANE_EVIDENCE_MARKER = "lane-evidence-must-stay-home";

async function createOwner(prefix: string): Promise<string> {
  const userId = `${prefix}-user-${randomUUID()}`;
  await db.insert(user).values({
    id: userId,
    name: "Export Owner",
    email: `${userId}@test.local`,
    emailVerified: true,
  });
  return userId;
}

async function createOrganization(
  prefix: string,
  ownerId: string,
  metadata: Record<string, unknown> | null = null,
): Promise<string> {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  await db.insert(organization).values({
    id: orgId,
    name: `Export ${prefix}`,
    slug: `${prefix}-${suffix}`,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId: ownerId,
    organizationId: orgId,
    role: "owner",
  });
  await withOrgContext(orgId, ownerId, "owner", async (tx) => {
    const snapshot = await loadCoaSnapshot(tx, orgId);
    const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
      onConflict: "renumber",
    });
    await executeCoaPlan(tx, orgId, plan, ownerId);
  });
  return orgId;
}

async function account(orgId: string, name: string) {
  const [row] = await db
    .select({
      id: accounts.id,
      accountNumber: accounts.accountNumber,
      accountType: accounts.accountType,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), eq(accounts.name, name)));
  if (!row) throw new Error(`No account "${name}" in ${orgId}`);
  return row;
}

async function party(orgId: string, name: string, partyType: "vendor" | "customer" = "vendor") {
  const [row] = await db
    .insert(parties)
    .values({ organizationId: orgId, name, partyType })
    .returning({ id: parties.id });
  return row.id;
}

function asCaller<T>(userId: string, orgId: string, fn: () => Promise<T>): Promise<T> {
  caller.userId = userId;
  caller.orgId = orgId;
  return fn();
}

/** Settings → Import, one entity at a time: validate the file, then import its valid rows. */
async function importEntity(
  userId: string,
  orgId: string,
  entityType: InboxEntity,
  content: string,
): Promise<{ invalid: number; result: ImportResult }> {
  return asCaller(userId, orgId, async () => {
    const validated = await api.validateImport({
      data: { entityType, content, format: "json" },
    });
    const rows = validated.rows.filter((row) => row.valid).map((row) => row.data);
    const result = await api.executeImport({ data: { entityType, rows } });
    return { invalid: validated.invalid, result };
  });
}

async function exactCreatedAt(snapshotId: string): Promise<string> {
  const [row] = await db
    .select({
      at: drizzleSql<string>`to_char(${ruleSnapshots.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(ruleSnapshots)
    .where(eq(ruleSnapshots.id, snapshotId));
  return row.at;
}

async function snapshotsOf(orgId: string) {
  const rows = await db
    .select()
    .from(ruleSnapshots)
    .where(eq(ruleSnapshots.organizationId, orgId))
    .orderBy(asc(ruleSnapshots.createdAt));
  return Promise.all(rows.map(async (row) => ({ ...row, exactAt: await exactCreatedAt(row.id) })));
}

async function routinesOf(orgId: string) {
  return db
    .select()
    .from(routines)
    .where(eq(routines.organizationId, orgId))
    .orderBy(asc(routines.name));
}

async function lanesOf(orgId: string) {
  return db
    .select()
    .from(aiAutonomyLanes)
    .where(eq(aiAutonomyLanes.organizationId, orgId))
    .orderBy(asc(aiAutonomyLanes.docKind));
}

async function memoriesOf(orgId: string) {
  return db
    .select()
    .from(classificationMemories)
    .where(eq(classificationMemories.organizationId, orgId))
    .orderBy(asc(classificationMemories.matchKind), asc(classificationMemories.matchKey));
}

integrationDescribe("export v5 round trip: routines, rule snapshots, memories, Jev lanes", () => {
  let owner: string;
  let src: string;
  let dst: string;
  let secret: string;
  let secretRef: string;
  let exported: ExportFile;
  let fileText: string;
  const imports = new Map<InboxEntity, { invalid: number; result: ImportResult }>();

  beforeAll(async () => {
    owner = await createOwner("export-v5");
    src = await createOrganization("export-v5-src", owner, {
      currency: "PHP",
      taxId: "123-456-789-000",
      addressCity: "Makati",
      inboxV2: true,
    });
    dst = await createOrganization("export-v5-dst", owner);

    // ── Source organization's Inbox configuration ──
    const hostingId = await party(src, HOSTING);
    const sourceOnlyVendorId = await party(src, SOURCE_ONLY_VENDOR);
    const [sourceOnlyAccount] = await db
      .insert(accounts)
      .values({ organizationId: src, accountType: "expense", ...SOURCE_ONLY_ACCOUNT })
      .returning({ id: accounts.id });
    const software = await account(src, "Business Applications & Software");
    const supplies = await account(src, "Office Supplies");
    const bank = await account(src, "Bank Accounts");

    const [baseline] = await db
      .insert(ruleSnapshots)
      .values({
        organizationId: src,
        label: "Baseline",
        createdBy: owner,
        snapshot: [
          {
            ruleKey: "missing_vendor",
            enabled: true,
            impact: "blocking",
            config: {},
            formulaVersion: 1,
          },
          {
            ruleKey: "low_confidence_category",
            enabled: true,
            impact: "warning",
            config: { threshold: "0.80" },
            formulaVersion: 2,
          },
        ],
      })
      .returning({ id: ruleSnapshots.id });
    const [candidate] = await db
      .insert(ruleSnapshots)
      .values({
        organizationId: src,
        label: null,
        createdBy: owner,
        snapshot: [
          {
            ruleKey: "missing_vendor",
            enabled: false,
            impact: "warning",
            config: {},
            formulaVersion: 1,
          },
        ],
      })
      .returning({ id: ruleSnapshots.id });

    await withOrgContext(src, owner, "owner", async (tx) => {
      const email = await ensureInboundEmailRoutine(tx, src);
      await setRoutineRuleSnapshot(tx, {
        orgId: src,
        actorId: owner,
        routineId: email.id,
        slot: "active",
        snapshotId: baseline.id,
      });
      const webhook = await createRoutine(tx, {
        orgId: src,
        actorId: owner,
        routine: { triggerKind: "webhook", name: "Receipts webhook" },
      });
      const rotated = await rotateRoutineWebhookSecret(tx, {
        orgId: src,
        actorId: owner,
        routineId: webhook.id,
      });
      secret = rotated.secret;
      const nightly = await createRoutine(tx, {
        orgId: src,
        actorId: owner,
        routine: {
          triggerKind: "schedule",
          name: "Nightly noop",
          schedule: { preset: "daily", at: "06:00", timezone: "Asia/Manila" },
          source: "noop",
        },
      });
      await setRoutineRuleSnapshot(tx, {
        orgId: src,
        actorId: owner,
        routineId: nightly.id,
        slot: "shadow",
        snapshotId: candidate.id,
      });
    });
    const [secretRow] = await db
      .select({ id: routineSecrets.id })
      .from(routineSecrets)
      .where(eq(routineSecrets.organizationId, src));
    secretRef = secretRow.id;

    const line = (
      side: "debit" | "credit",
      index: number,
      target: { id: string; accountType: string },
      amount: string,
    ) => ({
      lineMatch: { side, index },
      accountId: target.id,
      accountType: target.accountType,
      amount,
      currency: "USD",
      taxCode: null,
    });
    await db.insert(classificationMemories).values([
      {
        organizationId: src,
        matchKind: "sender_party",
        matchKey: "billing@roundtrip.example|123456789",
        answerDocKind: "purchase",
        answerPartyId: hostingId,
        answerLines: [line("debit", 0, software, "49.99"), line("credit", 0, bank, "49.99")],
        createdBy: owner,
        uses: 5,
        undos: 1,
      },
      {
        // A split: its remembered amounts replay exactly, so they must survive exactly.
        organizationId: src,
        matchKind: "party",
        matchKey: hostingId,
        answerDocKind: "purchase",
        answerPartyId: hostingId,
        answerLines: [
          line("debit", 0, software, "30.00"),
          line("debit", 1, supplies, "19.99000001"),
          line("credit", 0, bank, "49.99000001"),
        ],
        createdBy: owner,
        uses: 2,
      },
      {
        // Turned itself off after two undos in a row: it must arrive off.
        organizationId: src,
        matchKind: "line_text",
        matchKey: "HOSTING MONTHLY ROUNDTRIP",
        answerDocKind: "purchase",
        answerPartyId: null,
        answerLines: [line("debit", 0, supplies, "12.00"), line("credit", 0, bank, "12.00")],
        createdBy: owner,
        uses: 9,
        undos: 3,
        consecutiveUndos: 2,
        enabled: false,
      },
      {
        // Its party does not exist in the target organization.
        organizationId: src,
        matchKind: "file_hash",
        matchKey: FILE_HASH,
        answerDocKind: "purchase",
        answerPartyId: sourceOnlyVendorId,
        answerLines: [line("debit", 0, software, "8.00"), line("credit", 0, bank, "8.00")],
        createdBy: owner,
      },
      {
        // Its account does not exist in the target organization.
        organizationId: src,
        matchKind: "sender_party",
        matchKey: "ops@roundtrip.example|",
        answerDocKind: "purchase",
        answerPartyId: hostingId,
        answerLines: [
          line("debit", 0, { id: sourceOnlyAccount.id, accountType: "expense" }, "3.00"),
          line("credit", 0, bank, "3.00"),
        ],
        createdBy: owner,
      },
    ]);

    // Jev's lanes: one earned all the way to auto, one watching papers with no known party, and
    // one for a vendor the target does not have. The organization's Jev-approval switch is on,
    // and the auto lane has a label its level was earned with.
    const [autoLane] = await db
      .insert(aiAutonomyLanes)
      .values({
        organizationId: src,
        laneKey: "inbox_approve",
        partyId: hostingId,
        docKind: "expense",
        level: "auto",
        amountCap: "500",
        confidenceThreshold: "0.9500",
        promotedBy: owner,
        promotedAt: new Date(),
      })
      .returning({ id: aiAutonomyLanes.id });
    await db.insert(aiAutonomyLanes).values([
      { organizationId: src, laneKey: "inbox_approve", partyId: null, docKind: "vendor_bill" },
      {
        organizationId: src,
        laneKey: "inbox_approve",
        partyId: sourceOnlyVendorId,
        docKind: "money_in",
        level: "suggest",
        promotedBy: owner,
        promotedAt: new Date(),
      },
    ]);
    await db.insert(aiRunFeedback).values({
      organizationId: src,
      verdict: "accepted",
      userId: owner,
      laneId: autoLane.id,
      laneEvidence: {
        source: "jev",
        confidence: 0.97,
        wouldApprove: true,
        marker: LANE_EVIDENCE_MARKER,
      },
      labelKey: `export-v5:${randomUUID()}`,
    });
    await db.insert(organizationAiSettings).values({
      organizationId: src,
      inboxAutoapproveEnabled: true,
      inboxSpotCheckRate: "0.2500",
    });

    // ── The fresh target: same chart preset, its own parties (new ids) ──
    await party(dst, HOSTING);

    // ── Settings → Export ──
    exported = await asCaller(owner, src, () =>
      api.exportData({
        // "Include inactive records" left off, as by default: a disabled memory is still exported.
        data: { entities: ["orgSettings", ...INBOX_ENTITIES] },
      }),
    );
    fileText = JSON.stringify(exported);

    // ── Settings → Import, in dependency order ──
    for (const entity of INBOX_ENTITIES) {
      imports.set(entity, await importEntity(owner, dst, entity, fileText));
    }
  });

  it("writes a v5 file with the organization's real settings and no secret", () => {
    expect(exported.meta.version).toBe(5);
    const [settings] = exported.data.orgSettings as Array<Record<string, unknown>>;
    expect(settings).toMatchObject({
      currency: "PHP",
      taxId: "123-456-789-000",
      addressCity: "Makati",
    });
    expect(fileText).not.toContain(secret);
    expect(fileText).not.toContain(secretRef);
    expect(fileText).not.toMatch(/secret_ref|secretEnc|secret_enc/);
    const party = (exported.data.classificationMemories as Array<Record<string, unknown>>).find(
      (row) => row.matchKind === "party",
    );
    // A party memory's key is a party id: it travels as the party's name.
    expect(party).toMatchObject({ matchKey: null, matchPartyName: HOSTING });
  });

  it("imports every row the file carries, reporting the two unmappable memories", () => {
    for (const entity of INBOX_ENTITIES) expect(imports.get(entity)!.invalid).toBe(0);
    expect(imports.get("ruleSnapshots")!.result).toMatchObject({
      imported: 2,
      skipped: 0,
      failed: 0,
    });
    const routineResult = imports.get("routines")!.result;
    expect(routineResult).toMatchObject({ imported: 3, skipped: 0, failed: 0 });
    expect(routineResult.results.find((row) => row.name === "Receipts webhook")).toEqual({
      name: "Receipts webhook",
      success: true,
      error: IMPORTED_WEBHOOK_NOTE,
    });

    const memoryResult = imports.get("classificationMemories")!.result;
    expect(memoryResult).toMatchObject({ imported: 3, skipped: 0, failed: 2 });
    const dropped = memoryResult.results.filter((row) => !row.success);
    expect(dropped.map((row) => row.error)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Dropped: party "Source Only Vendor" is not here\.$/),
        expect.stringMatching(
          /^Dropped: account 69990 "Source Only Expense" is not in this chart\.$/,
        ),
      ]),
    );
  });

  it("restores the rule snapshots exactly, under new ids", async () => {
    const [source, target] = [await snapshotsOf(src), await snapshotsOf(dst)];
    expect(target).toHaveLength(2);
    for (const [index, original] of source.entries()) {
      const copy = target[index];
      expect(copy.id).not.toBe(original.id);
      expect(copy.label).toBe(original.label);
      expect(copy.snapshot).toEqual(original.snapshot);
      expect(copy.exactAt).toBe(original.exactAt);
      expect(copy.createdBy).toBeNull();
    }
  });

  it("restores the routines with their pins remapped, and signed webhooks off with no secret", async () => {
    const [source, target] = [await routinesOf(src), await routinesOf(dst)];
    const targetSnapshots = await snapshotsOf(dst);
    const snapshotByLabel = (label: string | null) =>
      targetSnapshots.find((snapshot) => snapshot.label === label)!.id;
    expect(target.map((row) => row.name)).toEqual(source.map((row) => row.name));

    const byName = (rows: typeof target, name: string) => rows.find((row) => row.name === name)!;

    const email = byName(target, "Inbound email");
    expect(email).toMatchObject({
      enabled: true,
      triggerKind: "webhook",
      triggerConfig: { provider: "resend", auth: "svix" },
      ruleSnapshotId: snapshotByLabel("Baseline"),
      shadowRuleSnapshotId: null,
      createdBy: null,
    });

    const webhook = byName(target, "Receipts webhook");
    const sourceWebhook = byName(source, "Receipts webhook");
    expect(sourceWebhook.triggerConfig.secret_ref).toBe(secretRef);
    expect(webhook.enabled).toBe(false);
    expect(webhook.triggerConfig).toEqual({ ...sourceWebhook.triggerConfig, secret_ref: null });
    expect(webhook.createdBy).toBe(owner);
    expect(
      await db.select().from(routineSecrets).where(eq(routineSecrets.organizationId, dst)),
    ).toHaveLength(0);

    const nightly = byName(target, "Nightly noop");
    const sourceNightly = byName(source, "Nightly noop");
    expect(nightly).toMatchObject({
      enabled: true,
      triggerKind: "schedule",
      triggerConfig: sourceNightly.triggerConfig,
      ruleSnapshotId: null,
      shadowRuleSnapshotId: snapshotByLabel(null),
      maxConcurrentRuns: sourceNightly.maxConcurrentRuns,
    });
    // Runtime state is not configuration: a fresh schedule, no history.
    expect(nightly.nextRunAt).not.toBeNull();
    expect(nightly.lastRunAt).toBeNull();
    expect(nightly.cursor).toBeNull();
  });

  it("restores the memories with parties and accounts remapped, and drops the rest", async () => {
    const source = await memoriesOf(src);
    const target = await memoriesOf(dst);
    const [srcHosting] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, src), eq(parties.name, HOSTING)));
    const [dstHosting] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, dst), eq(parties.name, HOSTING)));
    const srcChart = await db.select().from(accounts).where(eq(accounts.organizationId, src));
    const dstChart = await db.select().from(accounts).where(eq(accounts.organizationId, dst));
    const remapAccount = (id: string) => {
      const number = srcChart.find((row) => row.id === id)!.accountNumber;
      return dstChart.find((row) => row.accountNumber === number)!.id;
    };
    const remapParty = (id: string | null) => (id === srcHosting.id ? dstHosting.id : id);

    const kept = source.filter(
      (row) => row.matchKey !== FILE_HASH && row.matchKey !== "ops@roundtrip.example|",
    );
    const expected = kept
      .map((row) => ({
        matchKind: row.matchKind,
        matchKey: row.matchKind === "party" ? dstHosting.id : row.matchKey,
        answerDocKind: row.answerDocKind,
        answerPartyId: remapParty(row.answerPartyId),
        answerLines: row.answerLines!.map((line) => ({
          ...line,
          accountId: remapAccount(line.accountId),
        })),
        uses: row.uses,
        undos: row.undos,
        consecutiveUndos: row.consecutiveUndos,
        enabled: row.enabled,
        createdBy: owner,
        sourceFeedbackId: null,
      }))
      .sort((a, b) => `${a.matchKind}${a.matchKey}`.localeCompare(`${b.matchKind}${b.matchKey}`));
    const actual = target
      .map((row) => ({
        matchKind: row.matchKind,
        matchKey: row.matchKey,
        answerDocKind: row.answerDocKind,
        answerPartyId: row.answerPartyId,
        answerLines: row.answerLines,
        uses: row.uses,
        undos: row.undos,
        consecutiveUndos: row.consecutiveUndos,
        enabled: row.enabled,
        createdBy: row.createdBy,
        sourceFeedbackId: row.sourceFeedbackId,
      }))
      .sort((a, b) => `${a.matchKind}${a.matchKey}`.localeCompare(`${b.matchKind}${b.matchKey}`));
    expect(actual).toEqual(expected);
    // Nothing of the source organization leaks in: every id belongs to the target.
    const dstAccountIds = new Set(dstChart.map((row) => row.id));
    for (const row of target) {
      for (const line of row.answerLines!) expect(dstAccountIds.has(line.accountId)).toBe(true);
    }
  });

  it("exports each lane as configuration: no labels, no promoter, no switch", () => {
    const lanes = exported.data.aiAutonomyLanes as Array<Record<string, unknown>>;
    expect(lanes).toHaveLength(3);
    for (const lane of lanes) {
      expect(Object.keys(lane).sort()).toEqual(
        ["amountCap", "confidenceThreshold", "docKind", "laneKey", "level", "partyName"].sort(),
      );
    }
    expect(lanes.find((lane) => lane.docKind === "expense")).toEqual({
      laneKey: "inbox_approve",
      docKind: "expense",
      partyName: HOSTING,
      level: "auto",
      amountCap: "500.00000000",
      confidenceThreshold: "0.9500",
    });
    // ai_run_feedback, the switch and every user id stay in the source database.
    expect(fileText).not.toContain(LANE_EVIDENCE_MARKER);
    expect(fileText).not.toMatch(/laneEvidence|labelKey|verdict|inboxAutoapprove|spotCheck/i);
    expect(fileText).not.toContain(owner);
  });

  it("brings every lane in at watch, drops the unmappable one, and leaves Jev approval off", async () => {
    const { result } = imports.get("aiAutonomyLanes")!;
    expect(result).toMatchObject({ imported: 2, skipped: 0, failed: 1 });
    expect(result.results).toEqual(
      expect.arrayContaining([
        { name: `${HOSTING} · Paid expense`, success: true, error: importedLaneNote("auto") },
        { name: "No known party · Vendor bill", success: true, error: importedLaneNote("watch") },
        {
          name: `${SOURCE_ONLY_VENDOR} · Money in`,
          success: false,
          error: `Dropped: party "${SOURCE_ONLY_VENDOR}" is not here.`,
        },
      ]),
    );

    const [dstHosting] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, dst), eq(parties.name, HOSTING)));
    const target = await lanesOf(dst);
    expect(
      target.map((lane) => ({
        laneKey: lane.laneKey,
        partyId: lane.partyId,
        docKind: lane.docKind,
        level: lane.level,
        amountCap: lane.amountCap,
        confidenceThreshold: lane.confidenceThreshold,
        promotedBy: lane.promotedBy,
        promotedAt: lane.promotedAt,
        demotedAt: lane.demotedAt,
      })),
    ).toEqual([
      {
        laneKey: "inbox_approve",
        partyId: dstHosting.id,
        docKind: "expense",
        // Earned autonomy is never imported: this organization's reviews must earn it again.
        level: "watch",
        amountCap: "500.00000000",
        confidenceThreshold: "0.9500",
        promotedBy: null,
        promotedAt: null,
        demotedAt: null,
      },
      {
        laneKey: "inbox_approve",
        partyId: null,
        docKind: "vendor_bill",
        level: "watch",
        amountCap: null,
        confidenceThreshold: null,
        promotedBy: null,
        promotedAt: null,
        demotedAt: null,
      },
    ]);
    expect(
      await db.select().from(aiRunFeedback).where(eq(aiRunFeedback.organizationId, dst)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(organizationAiSettings)
        .where(eq(organizationAiSettings.organizationId, dst)),
    ).toHaveLength(0);
    expect((await loadJevApprovalSettings(db, dst)).autoApproveEnabled).toBe(false);
  });

  it("records who brought each row in", async () => {
    const logged = await db
      .select({ action: activityLogs.action, actorId: activityLogs.actorId })
      .from(activityLogs)
      .where(eq(activityLogs.organizationId, dst));
    const count = (action: string) =>
      logged.filter((row) => row.action === action && row.actorId === owner).length;
    expect(count("rule_snapshot_imported")).toBe(2);
    expect(count("routine_imported")).toBe(3);
    expect(count("memory_imported")).toBe(3);
    expect(count("jev_lane_imported")).toBe(2);
  });

  it("changes nothing when the same file is imported again", async () => {
    const before = {
      snapshots: (await snapshotsOf(dst)).length,
      routines: (await routinesOf(dst)).length,
      memories: (await memoriesOf(dst)).length,
      lanes: (await lanesOf(dst)).length,
    };
    for (const entity of INBOX_ENTITIES) {
      const { result } = await importEntity(owner, dst, entity, fileText);
      expect(result.imported, entity).toBe(0);
      for (const row of result.results.filter((entry) => entry.success)) {
        expect(row.error).toBe(DUPLICATE_SKIPPED);
      }
    }
    expect({
      snapshots: (await snapshotsOf(dst)).length,
      routines: (await routinesOf(dst)).length,
      memories: (await memoriesOf(dst)).length,
      lanes: (await lanesOf(dst)).length,
    }).toEqual(before);
  });

  it("never gives an organization a second inbound email routine", async () => {
    const other = await createOrganization("export-v5-email", owner);
    const provisioned = await withOrgContext(other, owner, "owner", (tx) =>
      ensureInboundEmailRoutine(tx, other),
    );
    await importEntity(owner, other, "ruleSnapshots", fileText);
    const { result } = await importEntity(owner, other, "routines", fileText);
    expect(result.results.find((row) => row.name === "Inbound email")).toEqual({
      name: "Inbound email",
      success: true,
      error: DUPLICATE_SKIPPED,
    });
    const emailRoutines = (await routinesOf(other)).filter(
      (row) => row.triggerConfig.provider === "resend",
    );
    expect(emailRoutines).toHaveLength(1);
    // The organization's own routine is kept as it was: import never re-pins it.
    expect(emailRoutines[0]).toMatchObject({ id: provisioned.id, ruleSnapshotId: null });
  });

  it("keeps a lane this organization already has, at the level it earned here", async () => {
    const other = await createOrganization("export-v5-lanes", owner);
    const hostingHere = await party(other, HOSTING);
    await db.insert(aiAutonomyLanes).values({
      organizationId: other,
      laneKey: "inbox_approve",
      partyId: hostingHere,
      docKind: "expense",
      level: "suggest",
      promotedBy: owner,
      promotedAt: new Date(),
    });
    const { result } = await importEntity(owner, other, "aiAutonomyLanes", fileText);
    expect(result.results.find((row) => row.name === `${HOSTING} · Paid expense`)).toEqual({
      name: `${HOSTING} · Paid expense`,
      success: true,
      error: DUPLICATE_SKIPPED,
    });
    const hostingLanes = (await lanesOf(other)).filter((lane) => lane.partyId === hostingHere);
    expect(hostingLanes).toHaveLength(1);
    expect(hostingLanes[0]).toMatchObject({ level: "suggest", amountCap: null });
  });

  it("refuses a routine whose pinned snapshot was not imported first", async () => {
    const other = await createOrganization("export-v5-nopin", owner);
    const { result } = await importEntity(owner, other, "routines", fileText);
    expect(result.results.find((row) => row.name === "Inbound email")).toMatchObject({
      success: false,
      error: expect.stringMatching(/pinned rule snapshot Baseline .* import Rule Snapshots first/),
    });
    expect(result.results.find((row) => row.name === "Nightly noop")).toMatchObject({
      success: false,
      error: expect.stringMatching(/shadow rule snapshot Untitled snapshot/),
    });
    // The unpinned webhook still comes in; the failures left nothing behind.
    expect((await routinesOf(other)).map((row) => row.name)).toEqual(["Receipts webhook"]);
  });

  it("fails a row the database refuses on its own, without leaking SQL or losing the rest", async () => {
    const other = await createOrganization("export-v5-savepoint", owner);
    const [snapshot] = exported.data.ruleSnapshots as Array<Record<string, unknown>>;
    const crafted = JSON.stringify({
      ...exported,
      data: {
        ruleSnapshots: [
          // Passes the file's shape checks; Postgres has no year zero.
          { ...snapshot, label: "Year zero", createdAt: "0000-01-01T00:00:00Z" },
          snapshot,
        ],
      },
    });
    const { invalid, result } = await importEntity(owner, other, "ruleSnapshots", crafted);
    expect(invalid).toBe(0);
    expect(result).toMatchObject({ imported: 1, failed: 1 });
    expect(result.results[0]).toEqual({
      name: "Year zero (0000-01-01T00:00:00Z)",
      success: false,
      error: "A database error occurred while importing this row.",
    });
    expect((await snapshotsOf(other)).map((row) => row.label)).toEqual(["Baseline"]);
  });
});
