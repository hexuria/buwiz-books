/**
 * Shared OrgMetadata schema and parser.
 * Single source of truth for org metadata stored in auth_organizations.metadata JSON.
 */
import { z } from "zod";

export const orgMetadataSchema = z.object({
  geminiDefaultModel: z.string().optional(),
  aiModelOcr: z.string().optional(),
  aiModelTextAnalysis: z.string().optional(),
  aiModelImageGen: z.string().optional(),
  enableImageGeneration: z.boolean().optional(),
  emailSenderName: z.string().optional(),
  emailSenderEmail: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  taxId: z.string().optional(),
  addressStreet: z.string().optional(),
  addressCity: z.string().optional(),
  addressState: z.string().optional(),
  addressPostalCode: z.string().optional(),
  addressCountry: z.string().optional(),
  logoUrl: z.string().optional(),
  currency: z.string().optional(),
  // Collected at onboarding. `industry` was previously written to the DB and
  // then stripped here by the only reader, so nothing could act on it.
  industry: z.string().optional(),
  fiscalYearEnd: z.string().optional(),
  // Which chart-of-accounts preset was applied, for provenance and upgrades.
  coaPresetId: z.string().optional(),
  coaPresetVersion: z.number().optional(),
  paymentProvider: z.string().optional(),
  stripePublishableKey: z.string().optional(),
  paypalClientId: z.string().optional(),
  paypalMode: z.enum(["sandbox", "live"]).optional(),
  paymentBankAccountId: z.string().optional(),
});

export type OrgMetadata = z.infer<typeof orgMetadataSchema>;

/**
 * Parse raw org metadata JSON into a typed OrgMetadata object.
 * Returns an empty object on parse failure or null input.
 * Unknown keys are stripped by Zod (strict mode not used — allows forward-compat).
 */
export function parseOrgMetadata(raw: string | null | undefined): OrgMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const result = orgMetadataSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}
