import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { callWithRetry } from "../../src/lib/gemini-client";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { updateOrganizationSecrets } from "../../src/lib/org-secrets";
import { eq } from "drizzle-orm";
import { SchemaType, ResponseSchema } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

// Real-API OCR fixtures live outside the repo. Point AI_OCR_FIXTURES_DIR at a
// local copy to run this test; otherwise it skips when the fixture is absent.
const OCR_FIXTURES_DIR = process.env.AI_OCR_FIXTURES_DIR ?? "";

// Extract schema for testing
const statementOcrSchema = {
  type: SchemaType.OBJECT,
  properties: {
    classification: {
      type: SchemaType.OBJECT,
      properties: {
        isStatement: { type: SchemaType.BOOLEAN },
        documentType: { type: SchemaType.STRING },
        confidence: { type: SchemaType.NUMBER },
      },
      required: ["isStatement", "documentType", "confidence"],
    },
    metadata: {
      type: SchemaType.OBJECT,
      properties: {
        institutionName: { type: SchemaType.STRING },
        accountHolderName: { type: SchemaType.STRING },
        accountType: { type: SchemaType.STRING },
        accountNumberLast4: { type: SchemaType.STRING },
        statementPeriodStart: { type: SchemaType.STRING },
        statementPeriodEnd: { type: SchemaType.STRING },
        beginningBalance: { type: SchemaType.NUMBER },
        endingBalance: { type: SchemaType.NUMBER },
        currency: { type: SchemaType.STRING },
      },
      required: [
        "institutionName",
        "accountHolderName",
        "accountType",
        "accountNumberLast4",
        "statementPeriodStart",
        "statementPeriodEnd",
        "beginningBalance",
        "endingBalance",
        "currency",
      ],
    },
    transactions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          date: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
          amount: { type: SchemaType.NUMBER },
        },
        required: ["date", "description", "amount"],
      },
    },
  },
  required: ["classification", "metadata", "transactions"],
} as const;

// Read only run this test if a real API key is available
const runTest =
  process.env.AI_EVALS_MODE === "live" &&
  process.env.GEMINI_API_KEY &&
  process.env.TEST_DATABASE_URL
    ? describe
    : describe.skip;

runTest("Real Gemini API Integration - Statement OCR", () => {
  let db: any;
  let ORG_ID: string;

  beforeAll(async () => {
    ({ db } = await createTestDb());

    ORG_ID = crypto.randomUUID();

    // Seed an organization; model preferences live in public metadata,
    // the REAL API key goes through the encrypting server-only secrets path.
    await db.insert(organization).values({
      id: ORG_ID,
      name: "AI Integration Test Org",
      slug: `ai-test-${Date.now()}`,
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

  it("should successfully parse a real bank statement PDF", async (ctx) => {
    const pdfPath = path.join(OCR_FIXTURES_DIR, "artifacts", "bank_statement_jan_2026.pdf");
    if (!fs.existsSync(pdfPath)) ctx.skip();
    const pdfBuffer = fs.readFileSync(pdfPath);
    const base64Content = pdfBuffer.toString("base64");

    const prompt = `You are an expert financial document parser. Extract ALL information according to the response schema from this bank statement.`;

    const result = await callWithRetry(
      {
        orgId: ORG_ID,
        task: "ocr",
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: statementOcrSchema as unknown as ResponseSchema,
        },
      },
      async (model) =>
        model.generateContent([
          prompt,
          {
            inlineData: {
              data: base64Content,
              mimeType: "application/pdf",
            },
          },
        ]),
    );

    const responseText = result.response.text();
    let jsonText = responseText.trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText
        .replace(/```json\\n?/g, "")
        .replace(/```\\n?/g, "")
        .trim();
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/```\\n?/g, "").trim();
    }

    const parsed = JSON.parse(jsonText);

    // Assert Classification
    expect(parsed.classification).toBeDefined();
    expect(parsed.classification.isStatement).toBe(true);

    // Assert Metadata
    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata.institutionName.length).toBeGreaterThan(0);
    expect(parsed.metadata.accountNumberLast4).toBeDefined();

    // Assert Transactions
    expect(parsed.transactions).toBeDefined();
    expect(Array.isArray(parsed.transactions)).toBe(true);
    expect(parsed.transactions.length).toBeGreaterThan(0);

    const firstTx = parsed.transactions[0];
    expect(!isNaN(new Date(firstTx.date).getTime())).toBe(true);
    expect(typeof firstTx.description).toBe("string");
    expect(typeof firstTx.amount).toBe("number");
  }, 30000); // 30 second timeout for the real API call
});
