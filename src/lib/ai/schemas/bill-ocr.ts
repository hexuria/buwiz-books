// Zod output schemas for the bill OCR + bounding-box tasks.
// Mirrors the Gemini responseSchema in src/routes/api/-ai-bill-ocr.ts.
// Core finance fields (amounts, isUncategorized) are strict; loose enum-ish
// strings the model sometimes fumbles (uncategorizedType, frequency) degrade
// to undefined instead of failing the whole parse.
import { z } from "zod";

const finiteNumber = z.number().refine(Number.isFinite, "Expected a finite number");
const ymdOrEmpty = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .or(z.literal(""));

const addressSchema = z.object({
  street: z.string().describe("Street address").optional(),
  city: z.string().describe("City").optional(),
  state: z.string().describe("State/Province").optional(),
  postalCode: z.string().describe("Postal/ZIP code").optional(),
  country: z.string().describe("Country").optional(),
});

export const billOcrOutputSchema = z.object({
  vendor: z
    .object({
      name: z.string().describe("Vendor company or business name"),
      email: z.string().describe("Vendor email address").optional(),
      phone: z.string().describe("Vendor phone number").optional(),
      website: z.string().describe("Vendor website URL").optional(),
      address: addressSchema.describe("Vendor mailing address").optional(),
    })
    .describe("The vendor/seller/from party on the invoice"),
  invoice: z
    .object({
      invoiceNumber: z
        .string()
        .describe("Invoice number, transaction number, or bill reference (e.g. INV-1047)")
        .optional(),
      invoiceDate: ymdOrEmpty.describe("Invoice creation date in YYYY-MM-DD format").optional(),
      dueDate: ymdOrEmpty
        .describe(
          "Payment due date in YYYY-MM-DD format. Resolve relative terms like 'Net 30' using the current date provided in the prompt.",
        )
        .optional(),
      amount: finiteNumber.describe("Total invoice amount"),
      notes: z
        .string()
        .describe("Any notes, description, or memo from the invoice body text")
        .optional(),
    })
    .describe("Invoice / bill details"),
  lineItems: z
    .array(
      z.object({
        description: z.string().describe("Line item description or service name"),
        quantity: finiteNumber.describe("Quantity").optional(),
        unitPrice: finiteNumber.describe("Price per unit").optional(),
        amount: finiteNumber.describe("Total amount for this line item"),
        suggestedCategoryNumber: z
          .string()
          .describe(
            "Account number from the provided chart of accounts that best matches this line item. Use the most specific match available.",
          )
          .optional(),
        suggestedCategoryName: z
          .string()
          .describe("Account name from the provided chart of accounts that best matches.")
          .optional(),
      }),
    )
    .describe("Individual line items / charges on the invoice"),
  recipient: z
    .object({
      name: z.string().describe("Recipient company name").optional(),
      email: z.string().describe("Recipient email").optional(),
      address: addressSchema.describe("Recipient address (the bill-to address)").optional(),
    })
    .describe("The recipient/buyer/to party on the invoice (our company)")
    .optional(),
  classification: z
    .object({
      overallCategoryNumber: z
        .string()
        .describe("Primary account number for this bill if all items share a category")
        .optional(),
      overallCategoryName: z.string().describe("Primary account name for this bill").optional(),
      confidence: z.number().describe("Confidence in category classification from 0.0 to 1.0"),
      isUncategorized: z
        .boolean()
        .describe("True if the AI could not determine a specific category from the chart"),
      uncategorizedType: z
        .enum(["expense", "liability", "asset"])
        .describe(
          "If uncategorized, the broad type: 'expense', 'liability', or 'asset'. Most bills are expenses.",
        )
        .optional()
        .catch(undefined),
    })
    .describe("Overall expense classification for the bill"),
  recurring: z
    .object({
      isRecurring: z
        .boolean()
        .describe(
          "True if this appears to be a recurring bill based on patterns like 'monthly', 'subscription', or consistent billing periods",
        ),
      frequency: z
        .enum(["weekly", "monthly", "quarterly", "yearly"])
        .describe("Detected frequency: weekly, monthly, quarterly, or yearly")
        .optional()
        .catch(undefined),
      reasoning: z
        .string()
        .describe("Brief explanation of why this was flagged as recurring (or not)")
        .optional(),
    })
    .describe("Recurring bill detection"),
  confidence: z
    .number()
    .describe("Overall confidence score from 0.0 to 1.0 on the accuracy of extraction"),
});

export type BillOcrOutput = z.infer<typeof billOcrOutputSchema>;

// Bounding boxes — [ymin, xmin, ymax, xmax] normalized 0–1000, page 0-indexed.
// label/page/text use .catch so they stay REQUIRED in the Gemini responseSchema
// (the model is asked for them) while missing/garbage values degrade to a
// benign default instead of failing the whole parse. text degrades to "" —
// the only consumer filters on truthiness, so "" behaves like absent.
export const boundingBoxOutputSchema = z.object({
  fieldId: z.string().describe("Field identifier"),
  label: z.string().describe("Human-readable label").catch(""),
  text: z.string().describe("Actual text content in the region").catch(""),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe("[ymin, xmin, ymax, xmax] normalized 0-1000"),
  page: z.number().int().describe("0-indexed page number").catch(0),
});

export const boundingBoxesOutputSchema = z.array(boundingBoxOutputSchema);

export type BoundingBoxOutput = z.infer<typeof boundingBoxOutputSchema>;
