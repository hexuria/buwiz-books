import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { callWithRetry } from "../../src/lib/gemini-client";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { updateOrganizationSecrets } from "../../src/lib/org-secrets";
import { eq } from "drizzle-orm";
import { SchemaType, ResponseSchema } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

// Real-API OCR fixtures (images/PDFs) live outside the repo. Point
// AI_OCR_FIXTURES_DIR at a local copy to run these tests; otherwise each test
// skips when its fixture is absent (e.g. CI, or a fresh checkout).
const OCR_FIXTURES_DIR = process.env.AI_OCR_FIXTURES_DIR ?? "";

const receiptFixture = (name: string) => path.join(OCR_FIXTURES_DIR, name);

// Using the exact schema from -ai-receipt-ocr.ts
const transactionLineSchema = {
  type: SchemaType.OBJECT,
  properties: {
    description: { type: SchemaType.STRING, description: "Line item description" },
    categoryId: { type: SchemaType.STRING, description: "Matched account ID" },
    categoryName: { type: SchemaType.STRING, description: "The account name that was matched" },
    amount: { type: SchemaType.STRING, description: "Amount as a decimal string" },
    debit: { type: SchemaType.STRING, description: "Debit amount as decimal string" },
    credit: { type: SchemaType.STRING, description: "Credit amount as decimal string" },
    departmentId: { type: SchemaType.STRING, description: "Matched department ID" },
    departmentName: { type: SchemaType.STRING, description: "Department name" },
    locationId: { type: SchemaType.STRING, description: "Matched location ID" },
    locationName: { type: SchemaType.STRING, description: "Location name" },
  },
  required: ["description", "categoryId", "categoryName", "amount", "debit", "credit"],
} as const;

const receiptTransactionSchema = {
  type: SchemaType.OBJECT,
  properties: {
    transactionType: {
      type: SchemaType.STRING,
      description: "Transaction type",
    },
    date: { type: SchemaType.STRING },
    memo: { type: SchemaType.STRING },
    partyId: { type: SchemaType.STRING },
    partyName: { type: SchemaType.STRING },
    referenceNumber: { type: SchemaType.STRING },
    categoryId: { type: SchemaType.STRING },
    categoryName: { type: SchemaType.STRING },
    departmentId: { type: SchemaType.STRING },
    departmentName: { type: SchemaType.STRING },
    locationId: { type: SchemaType.STRING },
    locationName: { type: SchemaType.STRING },
    transferFromCategoryId: { type: SchemaType.STRING },
    transferFromCategoryName: { type: SchemaType.STRING },
    transferToCategoryId: { type: SchemaType.STRING },
    transferToCategoryName: { type: SchemaType.STRING },
    amount: { type: SchemaType.STRING },
    lines: {
      type: SchemaType.ARRAY,
      items: transactionLineSchema,
    },
    confidence: { type: SchemaType.NUMBER },
    interpretation: { type: SchemaType.STRING },
    extractedEntities: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          entityType: { type: SchemaType.STRING },
          name: { type: SchemaType.STRING },
          identifier: { type: SchemaType.STRING },
          accountType: { type: SchemaType.STRING },
          matchedPartyId: { type: SchemaType.STRING },
        },
        required: ["entityType", "name", "identifier", "accountType", "matchedPartyId"],
      },
    },
    documentSubtype: { type: SchemaType.STRING },
  },
  required: [
    "transactionType",
    "date",
    "memo",
    "partyId",
    "partyName",
    "referenceNumber",
    "categoryId",
    "categoryName",
    "amount",
    "lines",
    "confidence",
    "interpretation",
    "extractedEntities",
    "documentSubtype",
  ],
} as const;

const runTest =
  process.env.AI_EVALS_MODE === "live" &&
  process.env.GEMINI_API_KEY &&
  process.env.TEST_DATABASE_URL
    ? describe
    : describe.skip;

runTest("Real Gemini API Integration - Receipt OCR", () => {
  let db: any;
  let ORG_ID: string;

  beforeAll(async () => {
    ({ db } = await createTestDb());

    ORG_ID = crypto.randomUUID();

    // Seed an organization; model preferences live in public metadata,
    // the REAL API key goes through the encrypting server-only secrets path.
    await db.insert(organization).values({
      id: ORG_ID,
      name: "AI Integration Test Org (Receipts)",
      slug: `ai-receipt-test-${Date.now()}`,
      metadata: JSON.stringify({
        aiModelOcr: "gemini-3.1-flash-image-preview",
        aiModelTextAnalysis: "gemini-3-flash-preview",
      }),
    });
    await updateOrganizationSecrets(db, ORG_ID, {
      geminiApiKeys: [process.env.GEMINI_API_KEY as string],
    });
  });

  afterAll(async () => {
    if (db && ORG_ID) {
      await db.delete(organization).where(eq(organization.id, ORG_ID));
    }
  });

  const runReceiptTest = async (
    imagePath: string,
    expectedVendor: string,
    expectedType: string,
  ) => {
    const buffer = fs.readFileSync(imagePath);
    const base64Content = buffer.toString("base64");

    // Simulate context passed to AI
    const accountsBlock = "No accounts provided. Leave categoryId as empty string.";
    const partiesBlock = "No parties provided. Leave partyId as empty string.";
    const departmentsBlock = "";
    const locationsBlock = "";
    const preExtractedBlock = "";
    const dateStr = "2026-04-22";

    const prompt = `You are an expert receipt and document parser for an accounting system.
    
    ## Current Date
    Today's date is: ${dateStr}
    
    ## Your Task
    Analyze the attached document (receipt, invoice, bill, payslip, or similar) and extract:
    1. Structured transaction data
    2. Entities mentioned in the document (banks, employees, vendors, customers, etc.)
    3. Document subtype classification
    
    ## Transaction Type Classification
    - **pay_out**: Most common. Any purchase, expense, bill payment, payroll, or outgoing payment.
    - **pay_in**: Income received, refunds, customer payments.
    - **journal**: Adjusting entries, depreciation, accruals (rare for receipts).
    - **transfer**: Moving money between accounts (rare for receipts).
    
    ${accountsBlock}
    ${partiesBlock}
    ${departmentsBlock}
    ${locationsBlock}
    ${preExtractedBlock}`;

    const result = await callWithRetry(
      {
        orgId: ORG_ID,
        task: "ocr",
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: receiptTransactionSchema as unknown as ResponseSchema,
        },
      },
      async (model) =>
        model.generateContent([
          prompt,
          {
            inlineData: {
              data: base64Content,
              mimeType: "image/png",
            },
          },
        ]),
    );

    const responseText = result.response.text();
    let jsonText = responseText.trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/```\n?/g, "").trim();
    }

    const parsed = JSON.parse(jsonText);

    // Verify the parsed data matches what we expect
    expect(parsed).toBeDefined();
    expect(parsed.transactionType).toBe("pay_out");
    expect(parsed.documentSubtype).toBe(expectedType);

    // Vendor matching
    expect(parsed.partyName.toLowerCase()).toContain(expectedVendor.toLowerCase());

    // Lines exist
    expect(parsed.lines).toBeDefined();
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.lines.length).toBeGreaterThan(0);

    // Amount is formatted properly
    expect(parsed.amount).toMatch(/^\\d+\\.\\d{2}$/);

    // Extracted entities
    expect(parsed.extractedEntities).toBeDefined();
    expect(Array.isArray(parsed.extractedEntities)).toBe(true);

    // At least the vendor should be extracted
    const vendorEntity = parsed.extractedEntities.find((e: any) => e.entityType === "vendor");
    expect(vendorEntity).toBeDefined();
    expect(vendorEntity?.name.toLowerCase()).toContain(expectedVendor.toLowerCase());
  };

  it("should parse the coffee shop receipt", async (ctx) => {
    const imagePath = receiptFixture("coffee_shop_receipt_mar_2026_1776852000853.png");
    if (!fs.existsSync(imagePath)) ctx.skip();
    await runReceiptTest(
      imagePath,
      "Brew", // Likely "Brew & Co" or something similar from Nano Banan
      "receipt",
    );
  }, 30000);

  it("should parse the hardware store receipt", async (ctx) => {
    const imagePath = receiptFixture("hardware_receipt_feb_2026_1776851966388.png");
    if (!fs.existsSync(imagePath)) ctx.skip();
    // Adding sleep to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await runReceiptTest(imagePath, "Hardware", "receipt");
  }, 30000);

  it("should parse the office supplies receipt", async (ctx) => {
    const imagePath = receiptFixture("office_supplies_receipt_jan_2026_1776851986378.png");
    if (!fs.existsSync(imagePath)) ctx.skip();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await runReceiptTest(imagePath, "Office", "receipt");
  }, 30000);
});
