import { describe, expect, it } from "vitest";
import { journalLineInputSchema } from "../../src/db/validation/journals";
import { convertBalancedLines, sumMoney } from "../../src/lib/inbox/money";

/**
 * Program 2 P2 — journal input hygiene (audit, ledger core).
 *
 * The line schema used to accept negative amounts and debit-AND-credit on
 * one line; a sum-only balance check then passed offsetting garbage and the
 * trial balance understated both columns. And per-line FX rounding could
 * unbalance a genuinely balanced entry at scale 8 — an error the user
 * cannot fix from the input side.
 */
describe("journal line input schema", () => {
  const base = { accountId: "9d5b0000-0000-4000-8000-000000000001" };

  it("accepts a clean one-sided line", () => {
    expect(journalLineInputSchema.safeParse({ ...base, debit: "100.00" }).success).toBe(true);
    expect(journalLineInputSchema.safeParse({ ...base, credit: "0.50" }).success).toBe(true);
  });

  it("refuses negative amounts", () => {
    expect(journalLineInputSchema.safeParse({ ...base, debit: "-100.00" }).success).toBe(false);
    expect(journalLineInputSchema.safeParse({ ...base, credit: "-1" }).success).toBe(false);
  });

  it("refuses non-numeric amounts", () => {
    expect(journalLineInputSchema.safeParse({ ...base, debit: "1e3" }).success).toBe(false);
    expect(journalLineInputSchema.safeParse({ ...base, debit: "abc" }).success).toBe(false);
  });

  it("refuses debit AND credit on one line", () => {
    expect(
      journalLineInputSchema.safeParse({ ...base, debit: "100.00", credit: "100.00" }).success,
    ).toBe(false);
    // A zero on one side is not "both sides".
    expect(
      journalLineInputSchema.safeParse({ ...base, debit: "100.00", credit: "0" }).success,
    ).toBe(true);
  });
});

describe("balanced FX conversion", () => {
  it("keeps a balanced entry balanced when thirds round against each other", () => {
    // 3 × 1.00 debits vs one 3.00 credit at a rate of 1/3: each debit rounds
    // to 0.33333333 (sum 0.99999999) while the credit rounds to 1.00000000 —
    // the exact drift the allocator repairs.
    const lines = [
      { originalDebit: "1.00", originalCredit: null },
      { originalDebit: "1.00", originalCredit: null },
      { originalDebit: "1.00", originalCredit: null },
      { originalDebit: null, originalCredit: "3.00" },
    ];
    const converted = convertBalancedLines(lines, "0.3333333333");
    const debits = sumMoney(converted.map((l) => l.functionalDebit));
    const credits = sumMoney(converted.map((l) => l.functionalCredit));
    expect(debits).toBe(credits);
  });

  it("both sides land on the single true rounded total", () => {
    const lines = [
      { originalDebit: "10.01", originalCredit: null },
      { originalDebit: "10.01", originalCredit: null },
      { originalDebit: null, originalCredit: "20.02" },
    ];
    const converted = convertBalancedLines(lines, "0.0733333333");
    const debits = sumMoney(converted.map((l) => l.functionalDebit));
    const credits = sumMoney(converted.map((l) => l.functionalCredit));
    expect(debits).toBe(credits);
    // target = round(20.02 × 0.0733333333) at scale 8
    expect(credits).toBe("1.46813333");
  });

  it("nudges by at most one 1e-8 unit per line", () => {
    const lines = [
      { originalDebit: "1.00", originalCredit: null },
      { originalDebit: "1.00", originalCredit: null },
      { originalDebit: "1.00", originalCredit: null },
      { originalDebit: null, originalCredit: "3.00" },
    ];
    const converted = convertBalancedLines(lines, "0.3333333333");
    for (const line of converted.slice(0, 3)) {
      const value = Number(line.functionalDebit);
      expect(Math.abs(value - 0.33333333)).toBeLessThanOrEqual(1e-8 + 1e-12);
    }
  });

  it("leaves an UNBALANCED entry alone so the real imbalance is reported", () => {
    const lines = [
      { originalDebit: "2.00", originalCredit: null },
      { originalDebit: null, originalCredit: "1.00" },
    ];
    const converted = convertBalancedLines(lines, "0.3333333333");
    expect(converted[0].functionalDebit).toBe("0.66666667");
    expect(converted[1].functionalCredit).toBe("0.33333333");
  });

  it("an identity rate is exact and untouched", () => {
    const lines = [
      { originalDebit: "123.45", originalCredit: null },
      { originalDebit: null, originalCredit: "123.45" },
    ];
    const converted = convertBalancedLines(lines, "1");
    expect(converted[0].functionalDebit).toBe("123.45");
    expect(converted[1].functionalCredit).toBe("123.45");
  });
});

describe("batch and balances wiring", () => {
  it("the batch repoint refuses ambiguous headers and the guard matches the write gate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(__dirname, "../..", "src/routes/api/transactions/-_batch.ts"),
      "utf-8",
    );
    expect(source).toContain("having(sql`count(*) > 1`)");
    expect(source).toContain("if (updates.accountId) {");
    expect(source).not.toContain("Trigger 0039");
  });

  it("account balances default to posted-only", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(__dirname, "../..", "src/routes/api/transactions/-_shared.ts"),
      "utf-8",
    );
    const balancesBlock = source.slice(source.indexOf("accountBalancesSchema"));
    expect(balancesBlock).toContain('.default(["posted"])');
  });

  it("bill line amounts are validated positive-numeric", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "../..", "src/routes/api/-bills.ts"), "utf-8");
    expect(source.match(/Line amount must be greater than zero/g)!.length).toBe(2);
  });

  it("the inbox service converts lines through the residual allocator", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "../..", "src/lib/inbox/service.ts"), "utf-8");
    expect(source).toContain("convertBalancedLines(originalSides, exchangeRate)");
    expect(source).not.toContain("multiplyMoney(originalDebit");
  });
});

describe("postedAt stamping ratchet (P3)", () => {
  it("every posted-status journal write in the posting libs stamps postedAt", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files = [
      "src/lib/journal-amendment.ts",
      "src/lib/invoice-payments.ts",
      "src/lib/manual-bill-payment.ts",
      "src/lib/bill-journal.ts",
      "src/lib/invoice-journal.ts",
      "src/lib/tax/annualization-posting.ts",
      "src/lib/tax/post-cwt-receivable.ts",
      "src/lib/tax/post-ewt-remittance.ts",
      "src/lib/tax/payroll-journal.ts",
      "src/routes/api/transactions/-_mutations.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(__dirname, "../..", file), "utf-8");
      const posted = source.match(/status: "posted",/g) ?? [];
      const stamped = source.match(/status: "posted",\s*\n\s*postedAt: new Date\(\),/g) ?? [];
      expect(
        stamped.length,
        `${file}: ${posted.length} posted write(s), ${stamped.length} stamped`,
      ).toBe(posted.length);
    }
  });
});
