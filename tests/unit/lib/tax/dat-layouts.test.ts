import { describe, it, expect } from "vitest";
import { validateLayout } from "@/lib/tax/dat-encoder";
import {
  ALL_LAYOUTS,
  ALPHALIST_1604C_HEADER,
  ALPHALIST_1604C_SCHEDULE_1_DETAIL,
  EXPECTED_FIELD_COUNTS,
  layoutKey,
  QAP_1601EQ_SCHEDULE_1_DETAIL,
  QAP_1601EQ_SCHEDULE_2_DETAIL,
  UNTRANSCRIBED_LAYOUTS,
} from "@/lib/tax/dat-layouts";

describe("layout integrity", () => {
  it.each(ALL_LAYOUTS.map((l) => [layoutKey(l), l] as const))(
    "%s has contiguous positions and unique names",
    (_key, layout) => {
      expect(validateLayout(layout)).toEqual([]);
    },
  );

  it.each(ALL_LAYOUTS.map((l) => [layoutKey(l), l] as const))(
    "%s matches the field count published in Annex A",
    (key, layout) => {
      // The counts come from the RMC, not from counting our own arrays — so a
      // dropped or merged field fails here rather than being restated.
      expect(EXPECTED_FIELD_COUNTS[key], `no expected count declared for ${key}`).toBeDefined();
      expect(layout.fields).toHaveLength(EXPECTED_FIELD_COUNTS[key]);
    },
  );

  it("declares an expected count for every layout, and no orphans", () => {
    const keys = ALL_LAYOUTS.map(layoutKey).sort();
    expect(Object.keys(EXPECTED_FIELD_COUNTS).sort()).toEqual(keys);
  });
});

describe("the traps Annex A sets", () => {
  it("puts SEQ_NUM at position 3 on 1601EQ, where 1601FQ puts it at 10", () => {
    // Same name, same meaning, different slot. One shared serializer across the
    // two silently shifts every field between.
    const seq = QAP_1601EQ_SCHEDULE_1_DETAIL.fields.find((f) => f.name === "seqNum");
    expect(seq?.pos).toBe(3);

    const fq = UNTRANSCRIBED_LAYOUTS.find((l) => l.formCode === "1601FQ");
    expect(fq?.note).toMatch(/position 3 to position 10/);
  });

  it("uses MM/YYYY for the QAP and MM/DD/YYYY for the annual alphalist", () => {
    // A shared date formatter writes the wrong width for one of them.
    const qapPeriod = QAP_1601EQ_SCHEDULE_1_DETAIL.fields.find((f) => f.name === "retrnPeriod");
    const annualPeriod = ALPHALIST_1604C_HEADER.fields.find((f) => f.name === "retrnPeriod");
    expect(qapPeriod?.width).toBe(7);
    expect(annualPeriod?.width).toBe(10);
  });

  it("starts the annual header at FTYPE_CODE, with no ALPHA_TYPE", () => {
    // The QAP families carry ALPHA_TYPE first; the annual ones do not.
    expect(ALPHALIST_1604C_HEADER.fields[0].name).toBe("ftypeCode");
    expect(ALPHALIST_1604C_HEADER.fields.some((f) => f.name === "alphaType")).toBe(false);
  });

  it("omits tax rate and amount withheld from the exempt schedule", () => {
    // Schedule 2 is the exempt / zero-rated schedule — there is no rate and
    // nothing was withheld, so the fields are absent rather than zero.
    const names = QAP_1601EQ_SCHEDULE_2_DETAIL.fields.map((f) => f.name);
    expect(names).not.toContain("taxRate");
    expect(names).not.toContain("actualAmtWthld");
    expect(names).toContain("incomePayment");
  });
});

describe("1604-C Schedule 1", () => {
  const names = ALPHALIST_1604C_SCHEDULE_1_DETAIL.fields.map((f) => f.name);

  it("carries a full previous-employer block", () => {
    // Eleven fields with no source other than the employee's prior 2316 —
    // which is why that certificate is a blocking intake requirement for a
    // mid-year hire rather than a nicety.
    const prev = names.filter((n) => n.startsWith("prev") && n !== "prevTaxWthld");
    expect(prev).toHaveLength(11);
  });

  it("mirrors it with a present-employer block of the same shape", () => {
    const prev = names.filter((n) => n.startsWith("prev") && n !== "prevTaxWthld");
    const pres = names.filter((n) => n.startsWith("pres") && n !== "presTaxWthld");
    expect(pres).toHaveLength(prev.length);
    // Same suffixes on both sides — a missing mirror field would shift the
    // whole present block.
    const suffix = (n: string) => n.replace(/^(prev|pres)/, "");
    expect(pres.map(suffix).sort()).toEqual(prev.map(suffix).sort());
  });

  it("carries the substituted-filing flag as its own field", () => {
    // Never inferred from the arithmetic: Illustration 14's Mr. Joey ends with
    // tax due exactly equal to tax withheld and is still disqualified.
    expect(names).toContain("subsFiling");
  });

  it("pictures money at two decimals, unlike Schedule 2", () => {
    // Schedule 2 pictures the same amounts 9(11).00, with ZERO decimals — the
    // same employee's pay is written differently depending on which schedule
    // they land in.
    const money = ALPHALIST_1604C_SCHEDULE_1_DETAIL.fields.filter(
      (f) => f.type === "numeric" && f.width === 14,
    );
    expect(money.length).toBeGreaterThan(20);

    const schedule2 = UNTRANSCRIBED_LAYOUTS.find((l) => l.formCode === "1604C" && l.schedule === 2);
    expect(schedule2?.note).toMatch(/ZERO decimals/);
  });
});

describe("untranscribed layouts", () => {
  it("declares what is missing rather than improvising it", () => {
    // A 59-field record whose order is guessed produces a file that parses
    // cleanly into WRONG columns — invisible until an assessment. Declaring the
    // gap is the correct behaviour, not a shortfall.
    expect(UNTRANSCRIBED_LAYOUTS.length).toBeGreaterThan(0);
    for (const entry of UNTRANSCRIBED_LAYOUTS) {
      expect(entry.note.length).toBeGreaterThan(20);
      expect(entry.formCode).toBeTruthy();
    }
  });

  it("does not ship an untranscribed layout as if it were complete", () => {
    const shipped = new Set(ALL_LAYOUTS.map((l) => `${l.formCode}:${l.scheduleNumber}`));
    // 1604-C Schedule 2 is named as missing and must not appear in ALL_LAYOUTS.
    expect(shipped.has("1604C:2")).toBe(false);
    expect(shipped.has("1601FQ:1")).toBe(false);
  });
});
