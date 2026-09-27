// ============================================================================
// Inbox stage 2 — the closed account list, the enum on the wire, and the
// mapping back. Pure: the façade runs against a stubbed runtime, never a
// provider.
// ============================================================================
import { describe, expect, it, vi } from "vitest";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { parseModelJson } from "@/lib/ai/parse-model-json";
import { categorizeLinesPrompt } from "@/lib/ai/prompts/categorize-lines";
import { redactPII, toRedactedPrompt } from "@/lib/ai/redact";
import {
  buildCategorizeLinesSchema,
  NO_FIT_CODE,
  type CategorizeLinesOutput,
} from "@/lib/ai/schemas/categorize-lines";
import { toStrictJsonSchema } from "@/lib/ai/schema-strict";
import { zodToGeminiSchema } from "@/lib/ai/zod-to-gemini-schema";
import {
  CATEGORY_ACCOUNT_TYPES,
  buildAccountCodeList,
  failedDecisions,
  formatConfidence,
  isSafeAccountCode,
  mapCategorizeLinesOutput,
  resolveCategoryLine,
  type CategoryLineRequest,
  type ChartAccount,
} from "@/lib/inbox/line-categorization";
import { evaluateBookRules, type BookRuleAccount } from "@/lib/inbox/rules";

function account(
  id: string,
  accountNumber: string | null,
  name: string,
  accountType: string,
  subtype: string | null,
  parentId: string | null = null,
  isActive = true,
): ChartAccount {
  return { id, accountNumber, name, accountType, subtype, parentId, isActive };
}

/** A slice of the base preset: roots, a parent with leaves, and the buckets. */
const CHART: ChartAccount[] = [
  account("root-exp", "60000", "Operating Expenses", "expense", null),
  account(
    "supplies",
    "67000",
    "Supplies & Materials",
    "expense",
    "supplies_and_materials",
    "root-exp",
  ),
  account("office", "67200", "Office Supplies", "expense", "supplies_and_materials", "supplies"),
  account(
    "computers",
    "67100",
    "Computers Expense",
    "expense",
    "supplies_and_materials",
    "supplies",
  ),
  account(
    "software",
    "65000",
    "Business Applications & Software",
    "expense",
    "business_application_software",
    "root-exp",
  ),
  account(
    "uncat",
    "69999",
    "Uncategorized Expense",
    "expense",
    "uncategorized_expenses",
    "root-exp",
  ),
  account(
    "retired",
    "68800",
    "Retired Account",
    "expense",
    "general_operations",
    "root-exp",
    false,
  ),
  account("hosting", "54000", "Hosting Fees", "cost_of_revenue", "hosting_fees"),
  account("bank", "11000", "Bank Accounts", "asset", "bank_accounts"),
  account("sales", "41000", "Sales Revenue", "revenue", "sales_revenue"),
  account("no-number", null, "Team Lunches", "expense", "meals", "root-exp"),
];

const OUTFLOW = CATEGORY_ACCOUNT_TYPES.outflow;
const LINE: CategoryLineRequest = {
  lineIndex: 0,
  side: "debit",
  direction: "outflow",
  description: "Printer paper and toner",
  amount: "84.25",
};

describe("the closed account list", () => {
  it("lists only active leaf accounts of the line's types, never the uncategorized bucket", () => {
    const list = buildAccountCodeList(CHART, OUTFLOW);
    expect(list.entries.map((entry) => entry.accountId)).toEqual([
      "hosting",
      "software",
      "computers",
      "office",
      "no-number",
    ]);
    // Parents (post rejects them), inactive accounts, other types, and the
    // uncategorized bucket (no fit is the explicit "none") are all absent.
    for (const absent of ["root-exp", "supplies", "uncat", "retired", "bank", "sales"]) {
      expect(
        list.entries.some((entry) => entry.accountId === absent),
        absent,
      ).toBe(false);
    }
    expect(list.truncated).toBe(false);
  });

  it("uses account numbers as codes and mints A<n> where there is none — never a uuid", () => {
    const list = buildAccountCodeList(CHART, OUTFLOW);
    expect(list.entries.map((entry) => entry.code)).toEqual([
      "54000",
      "65000",
      "67100",
      "67200",
      "A1",
    ]);
    expect(list.byCode.get("67200")?.accountId).toBe("office");
    expect(list.byCode.get("A1")?.name).toBe("Team Lunches");
    expect(list.entries.find((entry) => entry.code === "67200")?.group).toBe(
      "Supplies & Materials",
    );
  });

  it("never lets a code collide with the no-fit answer or be mangled by redaction", () => {
    expect(isSafeAccountCode("67200")).toBe(true);
    expect(isSafeAccountCode("none")).toBe(false);
    expect(isSafeAccountCode("NONE")).toBe(false);
    // Would be masked by the account redaction rule, so it could never be answered.
    expect(isSafeAccountCode("XX123456")).toBe(false);
    expect(isSafeAccountCode("")).toBe(false);
    expect(isSafeAccountCode("has space")).toBe(false);

    const hostile = [
      account("a", "none", "Named none", "expense", "meals"),
      account("b", "XX123456", "Masked", "expense", "meals"),
      account("c", "A1", "Literally A1", "expense", "meals"),
    ];
    const list = buildAccountCodeList(hostile, OUTFLOW);
    const codes = list.entries.map((entry) => entry.code);
    expect(codes).not.toContain(NO_FIT_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(list.byCode.get("A1")?.accountId).toBe("c");
  });

  it("is deterministic and truncates at the prompt ceiling", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      account(`acct-${index}`, String(70_000 + index), `Expense ${index}`, "expense", "meals"),
    );
    const first = buildAccountCodeList([...many].reverse(), OUTFLOW, 10);
    const second = buildAccountCodeList(many, OUTFLOW, 10);
    expect(first.entries).toEqual(second.entries);
    expect(first.entries).toHaveLength(10);
    expect(first.truncated).toBe(true);
  });

  it("renders into a prompt redaction leaves untouched, so Jev's fixed-point check passes", () => {
    const list = buildAccountCodeList(CHART, OUTFLOW);
    const prompt = categorizeLinesPrompt.build({
      document: {
        kind: "receipt",
        event: "purchase",
        counterparty: "Staples",
        description: "Printer paper and toner",
        currency: "USD",
      },
      lines: [{ ...LINE, allowedTypes: [...OUTFLOW] }],
      lineItems: [{ description: "Copy paper, 10 reams", amount: "54.20" }],
      accounts: list.entries.map(({ code, name, type, group }) => ({ code, name, type, group })),
    });
    expect(redactPII(prompt).hits).toEqual([]);
    for (const entry of list.entries) expect(prompt).toContain(`"code":"${entry.code}"`);
    expect(toRedactedPrompt(prompt).prompt).toBe(prompt);
  });
});

describe("the per-request schema is a closed enum on every provider", () => {
  const codes = ["54000", "67200", "A1"];
  const schema = buildCategorizeLinesSchema(codes);

  it("accepts a listed code and the no-fit answer", () => {
    for (const accountCode of ["67200", NO_FIT_CODE]) {
      const parsed = parseModelJson(
        schema,
        JSON.stringify({
          lines: [
            { lineIndex: 0, accountCode, confidence: 0.9, reason: "", suggestedNewCategory: "" },
          ],
        }),
      );
      expect(parsed.ok, accountCode).toBe(true);
    }
  });

  it("rejects a code outside the list", () => {
    const parsed = parseModelJson(
      schema,
      JSON.stringify({
        lines: [
          {
            lineIndex: 0,
            accountCode: "99999",
            confidence: 0.99,
            reason: "",
            suggestedNewCategory: "",
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("sends the enum to Gemini and in the strict JSON schema Jev receives", () => {
    const gemini = zodToGeminiSchema(schema);
    expect(gemini.properties?.lines.items?.properties?.accountCode).toMatchObject({
      type: "string",
      format: "enum",
      enum: [...codes, NO_FIT_CODE],
    });
    const strict = toStrictJsonSchema(schema) as {
      properties: {
        lines: {
          items: {
            properties: { accountCode: { enum: string[] }; confidence: { description: string } };
          };
        };
      };
    };
    expect(strict.properties.lines.items.properties.accountCode.enum).toEqual([
      ...codes,
      NO_FIT_CODE,
    ]);
    expect(strict.properties.lines.items.properties.confidence.description).toMatch(/0\.0 to 1\.0/);
  });
});

describe("mapping answers back to accounts", () => {
  const codes = buildAccountCodeList(CHART, OUTFLOW);
  const answer = (
    line: Partial<CategorizeLinesOutput["lines"][number]>,
  ): CategorizeLinesOutput => ({
    lines: [
      {
        lineIndex: 0,
        accountCode: "67200",
        confidence: 0.93,
        reason: "",
        suggestedNewCategory: "",
        ...line,
      },
    ],
  });
  const map = (output: CategorizeLinesOutput, lines = [LINE]) =>
    mapCategorizeLinesOutput(output, { lines, codes, minConfidence: 0.8 });

  it("maps a confident listed code to its account id", () => {
    expect(map(answer({}))).toEqual([
      { lineIndex: 0, outcome: "picked", accountId: "office", code: "67200", confidence: 0.93 },
    ]);
  });

  it("reads a bare 1 as certain, because the schema pins the unit scale", () => {
    expect(map(answer({ confidence: 1 }))[0]).toMatchObject({ outcome: "picked", confidence: 1 });
  });

  it("keeps a below-threshold pick only as a suggestion", () => {
    expect(map(answer({ confidence: 0.55 }))[0]).toEqual({
      lineIndex: 0,
      outcome: "low_confidence",
      suggestedAccountId: "office",
      code: "67200",
      confidence: 0.55,
    });
  });

  it("rejects an unknown code instead of guessing", () => {
    // Only reachable when a caller parsed with the static schema: the
    // per-request enum refuses it before mapping.
    expect(map(answer({ accountCode: "99999" }))[0]).toEqual({
      lineIndex: 0,
      outcome: "rejected",
      code: "99999",
      reason: "unknown_code",
    });
  });

  it("rejects a listed code of a type the line may not take", () => {
    const mixed = buildAccountCodeList(CHART, [...OUTFLOW, "revenue"]);
    const decisions = mapCategorizeLinesOutput(answer({ accountCode: "41000" }), {
      lines: [LINE],
      codes: mixed,
      minConfidence: 0.8,
    });
    expect(decisions[0]).toMatchObject({ outcome: "rejected", reason: "type_not_allowed" });
  });

  it("records no fit with the model's non-binding category suggestion", () => {
    expect(
      map(
        answer({ accountCode: NO_FIT_CODE, confidence: 0.9, suggestedNewCategory: "Coffee Beans" }),
      )[0],
    ).toEqual({
      lineIndex: 0,
      outcome: "no_fit",
      confidence: 0.9,
      suggestedNewCategory: "Coffee Beans",
    });
  });

  it("counts the first answer per line and treats an unanswered line as missing", () => {
    const second: CategoryLineRequest = { ...LINE, lineIndex: 1 };
    const output: CategorizeLinesOutput = {
      lines: [
        {
          lineIndex: 0,
          accountCode: "65000",
          confidence: 0.9,
          reason: "",
          suggestedNewCategory: "",
        },
        {
          lineIndex: 0,
          accountCode: "67200",
          confidence: 0.99,
          reason: "",
          suggestedNewCategory: "",
        },
      ],
    };
    expect(map(output, [LINE, second])).toEqual([
      { lineIndex: 0, outcome: "picked", accountId: "software", code: "65000", confidence: 0.9 },
      { lineIndex: 1, outcome: "missing" },
    ]);
  });
});

describe("no fit resolves to the mapped uncategorized account, and the rule blocks", () => {
  const noFitAccount = { id: "uncat", subtype: "uncategorized_expenses" };
  const ruleAccounts = new Map<string, BookRuleAccount>([
    [
      "office",
      { id: "office", accountType: "expense", subtype: "supplies_and_materials", childCount: 0 },
    ],
    [
      "uncat",
      { id: "uncat", accountType: "expense", subtype: "uncategorized_expenses", childCount: 0 },
    ],
  ]);
  const settings = {
    lowConfidenceThreshold: "0.8",
    missingReceiptThreshold: "75",
    missingReceiptCurrency: "USD",
    functionalCurrency: "USD",
  };

  function findingsFor(categoryAccountId: string | null, categoryConfidence: string | null) {
    // The payment side stays unselected until a reviewer picks it.
    const lines = [
      { accountId: categoryAccountId, debit: "84.25", categoryConfidence },
      { accountId: null, credit: "84.25" },
    ];
    return evaluateBookRules({
      candidate: {
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        exchangeRate: "1",
        lines,
      },
      lines,
      accounts: ruleAccounts,
      party: null,
      documents: [{ id: "doc", documentType: "receipt" }],
      settings,
    });
  }

  it.each([
    ["no fit", { lineIndex: 0, outcome: "no_fit", confidence: 0.9, suggestedNewCategory: null }],
    [
      "low confidence",
      {
        lineIndex: 0,
        outcome: "low_confidence",
        suggestedAccountId: "office",
        code: "67200",
        confidence: 0.4,
      },
    ],
    ["rejected code", { lineIndex: 0, outcome: "rejected", code: "99999", reason: "unknown_code" }],
    ["model failure", failedDecisions([LINE], "needs_review")[0]],
  ] as const)(
    "%s → Uncategorized Expense, and `uncategorized` blocks the line",
    (_label, decision) => {
      const resolved = resolveCategoryLine(decision as never, noFitAccount, 0.8);
      expect(resolved.accountId).toBe("uncat");
      expect(resolved.categoryConfidence).toBeNull();
      expect(resolved.evidence).toMatchObject({ selection: "no_fit_mapped_uncategorized" });

      const uncategorized = findingsFor(resolved.accountId, resolved.categoryConfidence).find(
        (finding) => finding.ruleKey === "uncategorized",
      );
      expect(uncategorized).toMatchObject({
        impact: "blocking",
        evidence: { lineIndexes: [0, 1] },
      });
    },
  );

  it("stays unselected — and still blocks — when no uncategorized account is mapped", () => {
    const resolved = resolveCategoryLine(
      { lineIndex: 0, outcome: "no_fit", confidence: 0.7, suggestedNewCategory: "Coffee Beans" },
      null,
      0.8,
    );
    expect(resolved).toMatchObject({
      accountId: null,
      evidence: { selection: "no_fit_unselected", suggestedNewCategory: "Coffee Beans" },
    });
    expect(
      findingsFor(null, null).find((finding) => finding.ruleKey === "uncategorized"),
    ).toMatchObject({ impact: "blocking", evidence: { lineIndexes: [0, 1] } });
  });

  it("applies a confident pick, which leaves only the payment side blocking", () => {
    const resolved = resolveCategoryLine(
      { lineIndex: 0, outcome: "picked", accountId: "office", code: "67200", confidence: 0.93 },
      noFitAccount,
      0.8,
    );
    expect(resolved).toMatchObject({ accountId: "office", categoryConfidence: "0.93" });
    const findings = findingsFor(resolved.accountId, resolved.categoryConfidence);
    expect(findings.find((finding) => finding.ruleKey === "uncategorized")?.evidence).toEqual({
      lineIndexes: [1],
    });
    expect(findings.some((finding) => finding.ruleKey === "low_confidence_category")).toBe(false);
  });

  it("stores confidence at the column's four decimals", () => {
    expect(formatConfidence(0.93456)).toBe("0.9346");
    expect(formatConfidence(1)).toBe("1");
    expect(formatConfidence(1.4)).toBe("1");
  });
});

describe("through the façade with a stubbed runtime", () => {
  function stubbed(text: string) {
    const runtime: AiCompletionRuntime = {
      prepare: vi.fn(async () => ({
        kind: "ready" as const,
        hops: [{ provider: "gemini" as const, model: "stub" }],
      })),
      invokeHop: vi.fn(async () => ({ text, invocationId: "inv-1", model: "stub" })),
      recordValidationOutcome: vi.fn(async () => undefined),
    };
    return { runtime, complete: createAiComplete(runtime) };
  }
  const codes = buildAccountCodeList(CHART, OUTFLOW);
  const codeList = codes.entries.map((entry) => entry.code);

  async function run(text: string) {
    const { runtime, complete } = stubbed(text);
    const result = await complete<CategorizeLinesOutput>({
      task: "categorize_lines",
      input: {
        document: {
          kind: "receipt",
          event: "purchase",
          counterparty: "",
          description: "",
          currency: "USD",
        },
        lines: [{ ...LINE, allowedTypes: [...OUTFLOW] }],
        lineItems: [],
        accounts: codes.entries,
      },
      schema: buildCategorizeLinesSchema(codeList),
      allowedIds: { accountCodes: new Set([...codeList, NO_FIT_CODE]) },
      ctx: { orgId: "org-1" },
    });
    return { result, runtime };
  }

  it("hands the per-request enum schema to the hop", async () => {
    const { runtime } = await run(
      JSON.stringify({
        lines: [
          {
            lineIndex: 0,
            accountCode: "67200",
            confidence: 0.9,
            reason: "",
            suggestedNewCategory: "",
          },
        ],
      }),
    );
    const hop = vi.mocked(runtime.invokeHop).mock.calls[0][0];
    expect(parseModelJson(hop.schema, JSON.stringify({ lines: [] })).ok).toBe(true);
    expect(
      parseModelJson(
        hop.schema,
        JSON.stringify({
          lines: [
            {
              lineIndex: 0,
              accountCode: "10000",
              confidence: 1,
              reason: "",
              suggestedNewCategory: "",
            },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("never lets an unknown code through: the answer needs review and the line falls to no fit", async () => {
    const { result } = await run(
      JSON.stringify({
        lines: [
          {
            lineIndex: 0,
            accountCode: "11000",
            confidence: 0.99,
            reason: "",
            suggestedNewCategory: "",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    const [decision] = failedDecisions([LINE], "needs_review");
    expect(
      resolveCategoryLine(decision, { id: "uncat", subtype: "uncategorized_expenses" }, 0.8)
        .accountId,
    ).toBe("uncat");
  });
});
