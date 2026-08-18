import { describe, expect, it } from "vitest";
import { form2307OcrOutputSchema } from "@/lib/ai/schemas/form-2307-ocr";
import { form2307OcrPrompt } from "@/lib/ai/prompts/form-2307-ocr";
import { AI_TASK_CATEGORY } from "@/lib/ai/types";
import { DEFAULT_CHAINS } from "@/lib/ai/chains";
import { zodToGeminiSchema } from "@/lib/ai/zod-to-gemini-schema";

/**
 * A received 2307 is the ONLY evidence supporting a creditable withholding tax
 * claim. An invented figure here becomes a false claim against the BIR, so the
 * extraction feeds a human review gate and the schema is built to make a
 * missing value visible rather than plausible.
 */
const valid = {
  payorTin: "123-456-789-000",
  payorRegisteredName: "ACME CORPORATION",
  payorAddress: "12 Ayala Ave, Makati",
  payeeTin: "999-888-777-000",
  payeeRegisteredName: "BUWIZ SOLUTIONS INC",
  certificateNumber: "2307-0001",
  periodFrom: "2026-04-01",
  periodTo: "2026-06-30",
  lines: [
    {
      atc: "WC010",
      incomePaymentDescription: "Professional fees",
      monthlyAmounts: ["30000.00", "35000.00", "35000.00"],
      totalIncomePayment: "100000.00",
      taxWithheld: "10000.00",
    },
  ],
  totalTaxWithheld: "10000.00",
  confidence: 0.94,
  legibilityNotes: "",
};

describe("form2307OcrOutputSchema", () => {
  it("parses a well-formed extraction", () => {
    const parsed = form2307OcrOutputSchema.parse(valid);
    expect(parsed.payorTin).toBe("123-456-789-000");
    expect(parsed.lines).toHaveLength(1);
  });

  it("keeps every money field a STRING", () => {
    // These become decimal(20,8) ledger amounts. A number would arrive as a JS
    // float and lose precision before reaching the money layer.
    const parsed = form2307OcrOutputSchema.parse(valid);
    expect(typeof parsed.totalTaxWithheld).toBe("string");
    expect(typeof parsed.lines[0].taxWithheld).toBe("string");
    expect(typeof parsed.lines[0].totalIncomePayment).toBe("string");
  });

  it("carries several ATC rows rather than merging them", () => {
    // One 2307 can list several ATCs for a quarter; merging destroys the SAWT
    // grouping.
    const parsed = form2307OcrOutputSchema.parse({
      ...valid,
      lines: [
        valid.lines[0],
        { ...valid.lines[0], atc: "WC100", totalIncomePayment: "50000", taxWithheld: "2500" },
      ],
    });
    expect(parsed.lines.map((l) => l.atc)).toEqual(["WC010", "WC100"]);
  });

  it("degrades on secondary fields rather than discarding the extraction", () => {
    // A certificate whose address block did not parse is still claimable.
    const parsed = form2307OcrOutputSchema.parse({
      ...valid,
      payorAddress: null,
      legibilityNotes: undefined,
      confidence: "not a number",
    });
    expect(parsed.payorAddress).toBe("");
    expect(parsed.confidence).toBe(0);
  });

  it("does NOT silently default the fields that decide the credit", () => {
    // A defaulted zero on TIN, ATC or the amounts is a wrong claim, not a
    // missing detail — so these must fail loudly instead.
    for (const field of ["payorTin", "payorRegisteredName", "totalTaxWithheld"]) {
      expect(() => form2307OcrOutputSchema.parse({ ...valid, [field]: undefined })).toThrow();
    }
    expect(() =>
      form2307OcrOutputSchema.parse({
        ...valid,
        lines: [{ ...valid.lines[0], atc: undefined }],
      }),
    ).toThrow();
  });

  it("accepts an empty string where the document was illegible", () => {
    // The prompt asks for empty rather than a guess; the schema has to accept
    // that, or the model is pushed into inventing a value.
    const parsed = form2307OcrOutputSchema.parse({
      ...valid,
      certificateNumber: "",
      lines: [{ ...valid.lines[0], taxWithheld: "" }],
    });
    expect(parsed.lines[0].taxWithheld).toBe("");
  });

  it("converts to a valid Gemini response schema", () => {
    // A Zod construct Gemini cannot express must fail here, never at request
    // time.
    const schema = zodToGeminiSchema(form2307OcrOutputSchema);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {})).toContain("payorTin");
  });
});

describe("form2307OcrPrompt", () => {
  it("tells the model to leave a field empty rather than guess", () => {
    const prompt = form2307OcrPrompt.build({});
    expect(prompt).toMatch(/return an EMPTY STRING/);
    expect(prompt).toMatch(/passes review and becomes a false claim/);
  });

  it("forbids deriving one figure from another", () => {
    // Computing tax from a believed rate produces a confident, wrong number
    // that looks exactly like a correct reading.
    const prompt = form2307OcrPrompt.build({});
    expect(prompt).toMatch(/Do NOT derive the tax withheld/);
    expect(prompt).toMatch(/Do NOT derive the income payment/);
    expect(prompt).toMatch(/Do NOT infer the ATC/);
  });

  it("tells it not to invent a certificate number", () => {
    expect(form2307OcrPrompt.build({})).toMatch(/Many legitimately have none/);
  });

  it("asks for the printed total separately from the rows", () => {
    // Reconciling the two is how a missed row is caught.
    expect(form2307OcrPrompt.build({})).toMatch(/how a missed row is caught/);
  });

  it("refuses to let the model tidy a transposed certificate", () => {
    // Swapping the fields to make them sensible hides a real finding.
    expect(form2307OcrPrompt.build({})).toMatch(/Do not swap the fields/);
  });

  it("includes our TIN so a misaddressed certificate is caught", () => {
    const prompt = form2307OcrPrompt.build({ ourTin: "999-888-777-000" });
    expect(prompt).toContain("999-888-777-000");
    expect(prompt).toMatch(/caught at review, not silently corrected/);
  });

  it("omits the optional blocks cleanly when nothing is supplied", () => {
    const prompt = form2307OcrPrompt.build({});
    expect(prompt).not.toContain("## Our TIN");
    expect(prompt).not.toContain("## Known parties");
  });
});

describe("registry wiring", () => {
  it("is classified as an OCR task for model selection", () => {
    expect(AI_TASK_CATEGORY.form_2307_ocr).toBe("ocr");
  });

  it("has a fallback chain that escalates", () => {
    // A 2307 is often a faint dot-matrix print or a creased photocopy, and its
    // figures become a tax credit.
    const chain = DEFAULT_CHAINS.form_2307_ocr;
    expect(chain.length).toBeGreaterThan(1);
    expect(chain.every((entry) => entry.provider === "gemini")).toBe(true);
  });
});
