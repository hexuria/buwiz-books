/**
 * Philippine tax identity for a party — employee, payee, or both.
 *
 * Every BIR artifact that names a person needs more than the party record
 * carries: a TIN with its branch code, a name split into the components the
 * forms and alphalists demand, and for an employee the employment dates and
 * minimum-wage status. `parties` has a generic `taxId` and a US-shaped
 * `is1099Vendor`, neither of which can carry this.
 *
 * ONE TABLE, TWO ROLES. An employee and a supplier need overlapping identity
 * (TIN, name, address) and disjoint specifics (employment dates versus a sworn
 * declaration). Splitting them would duplicate the overlap and force a join to
 * answer "who is this TIN", so the role-specific columns are nullable and the
 * CHECK constraints tie each set to the role that uses it.
 *
 * NAMES ARE STORED IN COMPONENTS, not as one string. The alphalist layouts have
 * separate LAST_NAME, FIRST_NAME and MIDDLE_NAME fields, and RMC 5-2014 bans
 * lumped entries — a name split at generation time by guessing at spaces is how
 * "DELA CRUZ, JUAN" becomes a rejected row.
 */
import {
  pgTable,
  uuid,
  text,
  date,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { parties } from "./parties";

/**
 * Residency / entity classification.
 *
 * Required by 1604-F Schedules 4 and 6 and 1601-FQ Schedule 3, and it drives
 * ATC selection for final withholding — so it is not optional metadata
 * (DECISIONS D-N13).
 */
export type PartyStatusCode =
  | "resident_citizen"
  | "resident_alien"
  | "non_resident_alien_etb"
  | "non_resident_alien_netb"
  | "domestic_corporation"
  | "resident_foreign_corporation"
  | "non_resident_foreign_corporation";

/** How the payee is taxed, which decides which withholding regime applies. */
export type PayeeType =
  | "individual"
  | "corporate"
  | "general_professional_partnership"
  | "government"
  | "cooperative"
  | "tax_exempt";

export const partyTaxProfiles = pgTable(
  "party_tax_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),

    // ── Identity ────────────────────────────────────────────────────────────
    /** Nine digits, no branch code and no separators. */
    tin: text("tin"),
    /**
     * Branch code, stored as FIVE digits.
     *
     * eBIRForms v7.9.6.0 widened it from three to five, but every published
     * alphalist layout still specifies four. We store the wider value and
     * truncate at .DAT generation, logging the truncation — see
     * IMPLEMENTATION-PLAN.md §A5.
     */
    branchCode: text("branch_code").default("00000"),
    rdoCode: text("rdo_code"),

    /** Individuals. Components, not one string — the alphalists demand them separately. */
    lastName: text("last_name"),
    firstName: text("first_name"),
    middleName: text("middle_name"),
    /** Non-individuals. */
    registeredName: text("registered_name"),

    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    province: text("province"),
    zipCode: text("zip_code"),

    payeeType: text("payee_type").$type<PayeeType>(),
    statusCode: text("status_code").$type<PartyStatusCode>(),

    // ── Employee-specific ───────────────────────────────────────────────────
    isEmployee: boolean("is_employee").default(false).notNull(),
    birthDate: date("birth_date"),
    dateHired: date("date_hired"),
    dateSeparated: date("date_separated"),
    /**
     * Minimum wage earner.
     *
     * DERIVED from the employee's rate against the regional wage order, never
     * declared — RR 11-2018 treats a wage-rate misrepresentation that creates
     * MWE status as grounds for disallowing the employer's whole compensation
     * expense (DECISIONS D4). Stored so a filed 2316 can be re-explained, and
     * refreshed when the wage order or the rate changes.
     */
    isMinimumWageEarner: boolean("is_minimum_wage_earner").default(false).notNull(),
    /** The DOLE region whose wage order governs, and which the meal-allowance ceiling reads. */
    regionCode: text("region_code"),
    /**
     * Eligible for substituted filing.
     *
     * Never inferred from the arithmetic. RR 11-2018 §2.83.4 disqualifies an
     * employee with two or more employers in the year "concurrently or
     * SUCCESSIVELY" — and Illustration 14's Mr. Joey ends with tax due exactly
     * equal to tax withheld yet is still disqualified, so a zero balance proves
     * nothing.
     */
    substitutedFilingEligible: boolean("substituted_filing_eligible").default(false).notNull(),
    /**
     * Alphalist nationality (e.g. "FILIPINO", "AMERICAN"). Null means the
     * 1604-C artifact defaults to FILIPINO and says so in a preflight warning.
     */
    nationality: varchar("nationality", { length: 40 }),

    // ── Payee-specific ──────────────────────────────────────────────────────
    isPayee: boolean("is_payee").default(false).notNull(),
    /** Default ATC when this payee's nature of payment does not vary. */
    defaultAtc: text("default_atc"),
    /**
     * The taxable year a sworn declaration of gross receipts covers.
     *
     * Gates the 5%-versus-10% professional-fee rate. Without one on file the
     * payor must withhold the HIGHER rate regardless of the payee's actual
     * income, so an absent year is not a neutral default.
     */
    swornDeclarationYear: text("sworn_declaration_year"),
    swornDeclarationReceivedAt: date("sworn_declaration_received_at"),
    /** VAT-registered payees take the higher professional-fee rate regardless of income. */
    isVatRegistered: boolean("is_vat_registered").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("party_tax_profiles_party").on(table.organizationId, table.partyId),
    index("party_tax_profiles_tin").on(table.organizationId, table.tin),
  ],
);

export const partyTaxProfilesRelations = relations(partyTaxProfiles, ({ one }) => ({
  party: one(parties, {
    fields: [partyTaxProfiles.partyId],
    references: [parties.id],
  }),
}));

/**
 * The name as an alphalist row needs it.
 *
 * Individuals go in as components; non-individuals use the registered name in
 * the last-name field with the others blank, which is what the layouts expect.
 */
export function alphalistName(profile: {
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  registeredName: string | null;
}): { last: string; first: string; middle: string } {
  if (profile.registeredName && !profile.lastName) {
    return { last: profile.registeredName, first: "", middle: "" };
  }
  return {
    last: profile.lastName ?? "",
    first: profile.firstName ?? "",
    middle: profile.middleName ?? "",
  };
}
