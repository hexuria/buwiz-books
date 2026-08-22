/** Party-tax beyond the employee TIN captured on /payroll. */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { parties } from "../../db/schema/parties";
import { partyTaxProfiles } from "../../db/schema/party-tax";
import { orgTaxRegistrations } from "../../db/schema/tax-stage-remainder";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { isPlaceholderTin } from "../../lib/tax/alphalist-preflight";

export const listPayeeTaxProfiles = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    return db
      .select({
        partyId: partyTaxProfiles.partyId,
        tin: partyTaxProfiles.tin,
        registeredName: partyTaxProfiles.registeredName,
        payeeType: partyTaxProfiles.payeeType,
        defaultAtc: partyTaxProfiles.defaultAtc,
        swornDeclarationYear: partyTaxProfiles.swornDeclarationYear,
        isVatRegistered: partyTaxProfiles.isVatRegistered,
      })
      .from(partyTaxProfiles)
      .where(eq(partyTaxProfiles.organizationId, orgId));
  });
});

const payeeSchema = z.object({
  name: z.string().min(1),
  tin: z.string().regex(/^\d{9}$/),
  registeredName: z.string().min(1),
  payeeType: z.enum(["individual", "corporate"]),
  defaultAtc: z.string().optional(),
  swornDeclarationYear: z.string().optional(),
  isVatRegistered: z.boolean().default(false),
});

export const upsertPayeeTaxProfile = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:payee-profile", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const input = payeeSchema.parse(rawData);
        if (isPlaceholderTin(input.tin)) {
          throw new Error("That payee TIN is a placeholder; dummy TINs are banned.");
        }
        const [existing] = await db
          .select({ partyId: partyTaxProfiles.partyId })
          .from(partyTaxProfiles)
          .where(
            and(eq(partyTaxProfiles.organizationId, orgId), eq(partyTaxProfiles.tin, input.tin)),
          )
          .limit(1);
        let partyId = existing?.partyId;
        if (!partyId) {
          const [party] = await db
            .insert(parties)
            .values({ organizationId: orgId, name: input.name, partyType: "vendor" })
            .returning({ id: parties.id });
          if (!party) throw new Error("Could not create payee");
          partyId = party.id;
        }
        await db
          .insert(partyTaxProfiles)
          .values({
            organizationId: orgId,
            partyId,
            tin: input.tin,
            registeredName: input.registeredName,
            payeeType: input.payeeType,
            defaultAtc: input.defaultAtc ?? null,
            swornDeclarationYear: input.swornDeclarationYear ?? null,
            isVatRegistered: input.isVatRegistered,
            isPayee: true,
          })
          .onConflictDoUpdate({
            target: [partyTaxProfiles.organizationId, partyTaxProfiles.partyId],
            set: {
              tin: input.tin,
              registeredName: input.registeredName,
              payeeType: input.payeeType,
              defaultAtc: input.defaultAtc ?? null,
              swornDeclarationYear: input.swornDeclarationYear ?? null,
              isVatRegistered: input.isVatRegistered,
              isPayee: true,
              updatedAt: new Date(),
            },
          });
        return { partyId, tin: input.tin };
      },
    );
  },
);

export const listTaxRegistrations = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    return db
      .select({
        id: orgTaxRegistrations.id,
        regimeKind: orgTaxRegistrations.regimeKind,
        value: orgTaxRegistrations.value,
        effectiveFrom: orgTaxRegistrations.effectiveFrom,
        effectiveTo: orgTaxRegistrations.effectiveTo,
        sourceEvent: orgTaxRegistrations.sourceEvent,
      })
      .from(orgTaxRegistrations)
      .where(eq(orgTaxRegistrations.organizationId, orgId))
      .orderBy(desc(orgTaxRegistrations.effectiveFrom));
  });
});

const registrationSchema = z.object({
  regimeKind: z.enum(["vat", "twa", "percentage_tax", "eight_percent"]),
  value: z.string().min(1),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sourceEvent: z.string().optional(),
});

export const addTaxRegistration = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:registration", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const input = registrationSchema.parse(rawData);
        const [row] = await db
          .insert(orgTaxRegistrations)
          .values({
            organizationId: orgId,
            regimeKind: input.regimeKind,
            value: input.value,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo ?? null,
            sourceEvent: input.sourceEvent ?? null,
          })
          .returning({ id: orgTaxRegistrations.id });
        if (!row) throw new Error("Could not store registration");
        return row;
      },
    );
  },
);
