import { describe, expect, it } from "vitest";
import {
  IMPORTED_WEBHOOK_NOTE,
  IMPORTED_WITHOUT_CHART_NOTE,
  classificationMemoryExportRowSchema,
  exportTriggerConfig,
  planMemoryImport,
  planRoutineImport,
  resolveAccountReference,
  routineExportRowSchema,
  type ChartAccountRef,
  type ClassificationMemoryExportRow,
  type PartyRef,
  type RoutineExportRow,
} from "@/lib/export-inbox-rows";
import { computeNextRunAt } from "@/lib/routines/schedule";

/**
 * The pure half of the v5 Inbox-configuration import: what a routine or a memory from a file
 * becomes in this organization. Secrets never survive, the chart gate still holds, and a memory
 * whose parties or accounts cannot be remapped is dropped with a reason — never pointed somewhere
 * else.
 */

const NOW = new Date("2026-09-27T02:00:00.000Z");
const SNAPSHOT_REF = {
  id: "7a6d3f4e-1111-4c1d-9e0a-1f2e3d4c5b6a",
  label: "Baseline",
  createdAt: "2026-09-20T08:30:00.123456Z",
};

function routine(overrides: Partial<Record<keyof RoutineExportRow, unknown>>): RoutineExportRow {
  return routineExportRowSchema.parse({
    name: "Receipts",
    enabled: true,
    triggerKind: "webhook",
    triggerConfig: {
      provider: "buwiz",
      auth: "hmac_sha256",
      secret_ref: "0f0e0d0c-0b0a-4908-8706-050403020100",
      tolerance_s: 120,
      max_bytes: 65_536,
    },
    ...overrides,
  });
}

describe("exportTriggerConfig", () => {
  it("drops the secret reference and nothing else", () => {
    expect(
      exportTriggerConfig({
        provider: "buwiz",
        auth: "hmac_sha256",
        secret_ref: "0f0e0d0c-0b0a-4908-8706-050403020100",
        tolerance_s: 300,
        max_bytes: 1024,
      }),
    ).toEqual({ provider: "buwiz", auth: "hmac_sha256", tolerance_s: 300, max_bytes: 1024 });
    expect(exportTriggerConfig({ provider: "resend", auth: "svix" })).toEqual({
      provider: "resend",
      auth: "svix",
    });
  });
});

describe("planRoutineImport", () => {
  it("brings a signed webhook in disabled, with no secret, and says why", () => {
    const plan = planRoutineImport(routine({}), { chartApplied: true, now: NOW });
    expect(plan).toEqual({
      ok: true,
      inboundEmail: false,
      values: {
        name: "Receipts",
        enabled: false,
        triggerKind: "webhook",
        triggerConfig: {
          provider: "buwiz",
          auth: "hmac_sha256",
          secret_ref: null,
          tolerance_s: 120,
          max_bytes: 65_536,
        },
        maxConcurrentRuns: 1,
        nextRunAt: null,
      },
      note: IMPORTED_WEBHOOK_NOTE,
    });
  });

  it("refuses a webhook that loosens the hard limits, or an unknown provider", () => {
    const loose = routine({
      triggerConfig: { provider: "buwiz", auth: "hmac_sha256", tolerance_s: 900, max_bytes: 10 },
    });
    expect(planRoutineImport(loose, { chartApplied: true, now: NOW }).ok).toBe(false);
    const other = routine({ triggerConfig: { provider: "zapier" } });
    expect(planRoutineImport(other, { chartApplied: true, now: NOW })).toEqual({
      ok: false,
      message: 'Unknown webhook provider "zapier".',
    });
  });

  it("keeps the inbound email routine's own state and rebuilds its config", () => {
    for (const enabled of [true, false]) {
      const plan = planRoutineImport(
        routine({
          name: "Inbound email",
          enabled,
          triggerConfig: { provider: "resend", auth: "svix", secret_ref: "x", extra: 1 },
        }),
        // Exempt from the chart gate, as when the first email provisions it.
        { chartApplied: false, now: NOW },
      );
      expect(plan).toMatchObject({
        ok: true,
        inboundEmail: true,
        note: null,
        values: { enabled, triggerConfig: { provider: "resend", auth: "svix" } },
      });
      if (plan.ok) expect(plan.values.triggerConfig).toEqual({ provider: "resend", auth: "svix" });
    }
  });

  it("enables a schedule only where a chart is applied, computing its next slot", () => {
    const config = {
      preset: "daily",
      at: "06:00",
      timezone: "Asia/Manila",
      source: "noop",
      cursor: "not-config",
    };
    const row = routine({ name: "Nightly", triggerKind: "schedule", triggerConfig: config });

    const withChart = planRoutineImport(row, { chartApplied: true, now: NOW });
    expect(withChart.ok).toBe(true);
    if (!withChart.ok) return;
    expect(withChart.values.enabled).toBe(true);
    expect(withChart.values.triggerConfig).toEqual({
      preset: "daily",
      at: "06:00",
      weekday: undefined,
      timezone: "Asia/Manila",
      source: "noop",
    });
    expect(withChart.values.nextRunAt).toEqual(
      computeNextRunAt({ preset: "daily", at: "06:00", timezone: "Asia/Manila" }, NOW),
    );
    expect(withChart.note).toBeNull();

    const withoutChart = planRoutineImport(row, { chartApplied: false, now: NOW });
    expect(withoutChart).toMatchObject({
      ok: true,
      values: { enabled: false, nextRunAt: null },
      note: IMPORTED_WITHOUT_CHART_NOTE,
    });

    const disabled = planRoutineImport(
      routine({ triggerKind: "schedule", triggerConfig: config, enabled: false }),
      { chartApplied: false, now: NOW },
    );
    expect(disabled).toMatchObject({ ok: true, values: { enabled: false }, note: null });
  });

  it("refuses schedules the app would not run, integrations, and a routine shadowing its own pin", () => {
    const plan = (row: RoutineExportRow) =>
      planRoutineImport(row, { chartApplied: true, now: NOW });
    expect(
      plan(
        routine({
          triggerKind: "schedule",
          triggerConfig: { preset: "daily", timezone: "UTC", source: "gusto" },
        }),
      ),
    ).toEqual({ ok: false, message: 'Unknown schedule source "gusto".' });
    expect(
      plan(
        routine({
          triggerKind: "schedule",
          triggerConfig: { preset: "weekly", timezone: "UTC", source: "noop" },
        }),
      ).ok,
    ).toBe(false);
    expect(plan(routine({ triggerKind: "integration", triggerConfig: {} })).ok).toBe(false);
    expect(plan(routine({ ruleSnapshot: SNAPSHOT_REF, shadowRuleSnapshot: SNAPSHOT_REF }))).toEqual(
      { ok: false, message: "A routine cannot shadow the rule snapshot it enforces." },
    );
  });
});

const IDS = {
  software: "11111111-1111-4111-8111-111111111111",
  checking: "22222222-2222-4222-8222-222222222222",
  retired: "33333333-3333-4333-8333-333333333333",
  dupA: "44444444-4444-4444-8444-444444444444",
  dupB: "55555555-5555-4555-8555-555555555555",
  acme: "66666666-6666-4666-8666-666666666666",
  twinA: "77777777-7777-4777-8777-777777777777",
  twinB: "88888888-8888-4888-8888-888888888888",
};

const CHART: ChartAccountRef[] = [
  {
    id: IDS.software,
    accountNumber: "6100",
    name: "Software",
    accountType: "expense",
    isActive: true,
  },
  {
    id: IDS.checking,
    accountNumber: "1010",
    name: "Checking",
    accountType: "asset",
    isActive: true,
  },
  {
    id: IDS.retired,
    accountNumber: "6900",
    name: "Old Expense",
    accountType: "expense",
    isActive: false,
  },
  { id: IDS.dupA, accountNumber: "6200", name: "Travel", accountType: "expense", isActive: true },
  { id: IDS.dupB, accountNumber: "6210", name: "Travel", accountType: "expense", isActive: true },
];

const PARTIES: PartyRef[] = [
  { id: IDS.acme, name: "Acme Hosting" },
  { id: IDS.twinA, name: "Twin Co" },
  { id: IDS.twinB, name: "Twin Co" },
];

function memory(
  overrides: Partial<Record<keyof ClassificationMemoryExportRow, unknown>> = {},
): ClassificationMemoryExportRow {
  return classificationMemoryExportRowSchema.parse({
    matchKind: "sender_party",
    matchKey: "billing@acme.example|123456789",
    answerDocKind: "purchase",
    answerPartyName: "Acme Hosting",
    answerLines: [
      {
        lineMatch: { side: "debit", index: 0 },
        accountNumber: "6100",
        accountName: "Software",
        accountType: "expense",
        amount: "49.99000000",
        currency: "USD",
        taxCode: null,
      },
      {
        lineMatch: { side: "credit", index: 0 },
        accountNumber: "1010",
        accountName: "Checking",
        accountType: "asset",
        amount: "49.99",
        currency: "USD",
        taxCode: null,
      },
    ],
    uses: 7,
    undos: 1,
    consecutiveUndos: 0,
    enabled: true,
    ...overrides,
  });
}

function withLine(index: number, patch: Record<string, unknown>) {
  const lines = memory().answerLines.map((line, at) =>
    at === index ? { ...line, ...patch } : line,
  );
  return memory({ answerLines: lines });
}

describe("resolveAccountReference", () => {
  it("resolves by number first, then by a name only one account has", () => {
    expect(
      resolveAccountReference(CHART, { accountNumber: "6100", accountName: "Renamed" }),
    ).toEqual({ ok: true, value: CHART[0] });
    expect(
      resolveAccountReference(CHART, { accountNumber: null, accountName: "Checking" }),
    ).toEqual({ ok: true, value: CHART[1] });
    expect(
      resolveAccountReference(CHART, { accountNumber: "9999", accountName: "Software" }),
    ).toEqual({ ok: true, value: CHART[0] });
  });

  it("maps neither a shared name, a retired account, nor nothing", () => {
    expect(resolveAccountReference(CHART, { accountNumber: null, accountName: "Travel" }).ok).toBe(
      false,
    );
    expect(resolveAccountReference(CHART, { accountNumber: "6900", accountName: null }).ok).toBe(
      false,
    );
    expect(resolveAccountReference(CHART, { accountNumber: null, accountName: null }).ok).toBe(
      false,
    );
  });
});

describe("planMemoryImport", () => {
  const refs = { chart: CHART, parties: PARTIES };

  it("remaps the party and every account onto this organization's ids", () => {
    const plan = planMemoryImport(memory(), refs);
    expect(plan).toEqual({
      ok: true,
      values: {
        matchKind: "sender_party",
        matchKey: "billing@acme.example|123456789",
        answerDocKind: "purchase",
        answerPartyId: IDS.acme,
        answerLines: [
          {
            lineMatch: { side: "debit", index: 0 },
            accountId: IDS.software,
            accountType: "expense",
            amount: "49.99000000",
            currency: "USD",
            taxCode: null,
          },
          {
            lineMatch: { side: "credit", index: 0 },
            accountId: IDS.checking,
            accountType: "asset",
            amount: "49.99",
            currency: "USD",
            taxCode: null,
          },
        ],
        uses: 7,
        undos: 1,
        consecutiveUndos: 0,
        enabled: true,
      },
    });
  });

  it("keys a party memory by the party's id here", () => {
    const plan = planMemoryImport(
      memory({ matchKind: "party", matchKey: null, matchPartyName: "Acme Hosting" }),
      refs,
    );
    expect(plan).toMatchObject({ ok: true, values: { matchKind: "party", matchKey: IDS.acme } });
  });

  it("drops, with the reason, a memory whose references cannot all be mapped", () => {
    const cases: Array<[ClassificationMemoryExportRow, RegExp]> = [
      [withLine(0, { accountNumber: "7777", accountName: "Nowhere" }), /not in this chart/],
      [withLine(0, { accountNumber: "6900", accountName: "Old Expense" }), /inactive/],
      [withLine(0, { accountNumber: null, accountName: "Travel" }), /matches 2 accounts/],
      [withLine(0, { accountNumber: null, accountName: null }), /no longer exists/],
      [
        withLine(1, { accountType: "liability" }),
        /asset here, but the memory was saved for liability/,
      ],
      [memory({ answerPartyName: "Globex" }), /party "Globex" is not here/],
      [memory({ answerPartyName: "Twin Co" }), /matches 2 parties/],
      [memory({ matchKind: "party", matchKey: null, matchPartyName: null }), /no longer exists/],
    ];
    for (const [row, reason] of cases) {
      const plan = planMemoryImport(row, refs);
      expect(plan.ok).toBe(false);
      if (plan.ok) continue;
      expect(plan.dropped).toBe(true);
      expect(plan.message).toMatch(/^Dropped: /);
      expect(plan.message).toMatch(reason);
    }
  });

  it("carries a turned-off memory and its undo counts as they were", () => {
    const plan = planMemoryImport(
      memory({ enabled: false, uses: 12, undos: 4, consecutiveUndos: 2 }),
      refs,
    );
    expect(plan).toMatchObject({
      ok: true,
      values: { enabled: false, uses: 12, undos: 4, consecutiveUndos: 2 },
    });
  });
});
