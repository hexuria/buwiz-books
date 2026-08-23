/**
 * Export / Import Server Functions (v2 — Versioned)
 * Handles bulk export and import of organization data.
 * Supports 16 entity types with versioned export format.
 */
import { createServerFn } from "@tanstack/react-start";

import { financialAccounts } from "../../db/schema/financial-accounts";
import { parties } from "../../db/schema/parties";
import { accounts } from "../../db/schema/accounts";
import { dimensions } from "../../db/schema/dimensions";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../../db/schema/journals";
import { bills, billLineItems } from "../../db/schema/bills";
import { invoices, invoiceLineItems } from "../../db/schema/invoices";
import { products } from "../../db/schema/products";
import { numberSequences } from "../../db/schema/number-sequences";
import { organization } from "../../db/schema/auth";
import { eq, and, asc, desc, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
  withSessionOrgContext,
} from "../../lib/server-context";
import { EXPORT_VERSION } from "../../lib/export-versions";
import type { ExportMeta, VersionedExportFile } from "../../lib/export-versions";
// Migration engine — used by import flow to handle legacy v1 files
// import { migrateToLatest } from "../../lib/export-migrations";

// ============================================================================
// Types
// ============================================================================

export type EntityType =
  | "banks"
  | "vendors"
  | "customers"
  | "employees"
  | "shareholders"
  | "lenders"
  | "government"
  | "categories"
  | "departments"
  | "locations"
  | "products"
  | "transactions"
  | "bills"
  | "invoices"
  | "numberSequences"
  | "orgSettings";

export const ENTITY_TYPES: EntityType[] = [
  "categories",
  "departments",
  "locations",
  "products",
  "vendors",
  "customers",
  "employees",
  "shareholders",
  "lenders",
  "government",
  "banks",
  "transactions",
  "bills",
  "invoices",
  "numberSequences",
  "orgSettings",
];

/** Map plural entity key to singular DB enum value for party types */
const PARTY_TYPE_MAP: Record<string, string> = {
  employees: "employee",
  shareholders: "shareholder",
  lenders: "lender",
  government: "government",
};

// ============================================================================
// Export Data
// ============================================================================

const ENTITY_ENUM = [
  "banks",
  "vendors",
  "customers",
  "employees",
  "shareholders",
  "lenders",
  "government",
  "categories",
  "departments",
  "locations",
  "products",
  "transactions",
  "bills",
  "invoices",
  "numberSequences",
  "orgSettings",
] as const;

const exportDataSchema = z.object({
  entities: z.array(z.enum(ENTITY_ENUM)),
  ids: z.record(z.string(), z.array(z.string())).optional(),
  includeInactive: z.boolean().default(false),
});

export const exportData = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    // report:export is withheld from member and clientApprover. Gating on
    // the session alone let either role export the organization's books,
    // which is the one thing that grant exists to prevent.
    return withPermissionOrgContext("report", "export", async ({ orgId, db }) => {
      const { entities, ids, includeInactive } = exportDataSchema.parse(rawData);

      const result: Record<string, any> = {};

      for (const entity of entities) {
        switch (entity) {
          case "banks": {
            const conditions = [eq(financialAccounts.organizationId, orgId)];
            if (!includeInactive) conditions.push(eq(financialAccounts.isActive, true));
            if (ids?.banks?.length) conditions.push(inArray(financialAccounts.id, ids.banks));

            // The ledger link exports as a RESOLVABLE pair (number + name),
            // not the raw uuid — ids mean nothing in another database, which
            // is how the link silently vanished on every import (audit,
            // rules doc "Common Mistake #3"). Wire details ride along.
            const rows = await db
              .select({
                accountName: financialAccounts.accountName,
                institutionName: financialAccounts.institutionName,
                accountType: financialAccounts.accountType,
                lastFour: financialAccounts.lastFour,
                isManual: financialAccounts.isManual,
                connectionStatus: financialAccounts.connectionStatus,
                isActive: financialAccounts.isActive,
                accountNumber: financialAccounts.accountNumber,
                routingNumber: financialAccounts.routingNumber,
                swiftCode: financialAccounts.swiftCode,
                iban: financialAccounts.iban,
                ledgerAccountNumber: accounts.accountNumber,
                ledgerAccountName: accounts.name,
              })
              .from(financialAccounts)
              .leftJoin(accounts, eq(financialAccounts.ledgerAccountId, accounts.id))
              .where(and(...conditions))
              .orderBy(asc(financialAccounts.accountName));

            result.banks = rows;
            break;
          }

          case "vendors": {
            const conditions = [
              eq(parties.organizationId, orgId),
              or(eq(parties.partyType, "vendor"), eq(parties.partyType, "both"))!,
            ];
            if (!includeInactive) conditions.push(eq(parties.isActive, true));
            if (ids?.vendors?.length) conditions.push(inArray(parties.id, ids.vendors));

            const rows = await db
              .select({
                name: parties.name,
                partyType: parties.partyType,
                email: parties.email,
                phone: parties.phone,
                website: parties.website,
                address: parties.address,
                is1099Vendor: parties.is1099Vendor,
                taxId: parties.taxId,
                bankRoutingNumber: parties.bankRoutingNumber,
                bankAccountNumber: parties.bankAccountNumber,
                mailingAddress: parties.mailingAddress,
                paymentTerms: parties.paymentTerms,
                creditLimit: parties.creditLimit,
                description: parties.description,
                notes: parties.notes,
                isActive: parties.isActive,
                defaultAccountNumber: accounts.accountNumber,
                defaultAccountName: accounts.name,
              })
              .from(parties)
              .leftJoin(accounts, eq(parties.defaultAccountId, accounts.id))
              .where(and(...conditions))
              .orderBy(asc(parties.name));

            result.vendors = rows;
            break;
          }

          case "customers": {
            const conditions = [
              eq(parties.organizationId, orgId),
              or(eq(parties.partyType, "customer"), eq(parties.partyType, "both"))!,
            ];
            if (!includeInactive) conditions.push(eq(parties.isActive, true));
            if (ids?.customers?.length) conditions.push(inArray(parties.id, ids.customers));

            const rows = await db
              .select({
                name: parties.name,
                partyType: parties.partyType,
                email: parties.email,
                phone: parties.phone,
                website: parties.website,
                address: parties.address,
                taxId: parties.taxId,
                bankRoutingNumber: parties.bankRoutingNumber,
                bankAccountNumber: parties.bankAccountNumber,
                mailingAddress: parties.mailingAddress,
                paymentTerms: parties.paymentTerms,
                creditLimit: parties.creditLimit,
                description: parties.description,
                notes: parties.notes,
                isActive: parties.isActive,
                defaultAccountNumber: accounts.accountNumber,
                defaultAccountName: accounts.name,
              })
              .from(parties)
              .leftJoin(accounts, eq(parties.defaultAccountId, accounts.id))
              .where(and(...conditions))
              .orderBy(asc(parties.name));

            result.customers = rows;
            break;
          }

          case "categories": {
            const conditions = [eq(accounts.organizationId, orgId)];
            if (!includeInactive) conditions.push(eq(accounts.isActive, true));
            if (ids?.categories?.length) conditions.push(inArray(accounts.id, ids.categories));

            // Fetch all so we can resolve parent names
            const allAccounts = await db
              .select()
              .from(accounts)
              .where(and(...conditions))
              .orderBy(asc(accounts.accountNumber), asc(accounts.name));

            const idToName = new Map(allAccounts.map((a) => [a.id, a.name]));

            result.categories = allAccounts.map((a) => ({
              accountNumber: a.accountNumber,
              name: a.name,
              description: a.description,
              accountType: a.accountType,
              subtype: a.subtype,
              parentName: a.parentId ? (idToName.get(a.parentId) ?? null) : null,
              icon: a.icon,
              status: a.status,
              isActive: a.isActive,
            }));
            break;
          }

          case "departments": {
            const conditions = [
              eq(dimensions.organizationId, orgId),
              eq(dimensions.dimensionType, "department"),
            ];
            if (!includeInactive) conditions.push(eq(dimensions.isActive, true));
            if (ids?.departments?.length) conditions.push(inArray(dimensions.id, ids.departments));

            const allDepts = await db
              .select()
              .from(dimensions)
              .where(and(...conditions))
              .orderBy(asc(dimensions.name));

            const idToName = new Map(allDepts.map((d) => [d.id, d.name]));

            result.departments = allDepts.map((d) => ({
              name: d.name,
              code: d.code,
              description: d.description,
              parentName: d.parentId ? (idToName.get(d.parentId) ?? null) : null,
              isActive: d.isActive,
            }));
            break;
          }

          case "locations": {
            const conditions = [
              eq(dimensions.organizationId, orgId),
              eq(dimensions.dimensionType, "location"),
            ];
            if (!includeInactive) conditions.push(eq(dimensions.isActive, true));
            if (ids?.locations?.length) conditions.push(inArray(dimensions.id, ids.locations));

            const allLocs = await db
              .select()
              .from(dimensions)
              .where(and(...conditions))
              .orderBy(asc(dimensions.name));

            const idToName = new Map(allLocs.map((l) => [l.id, l.name]));

            result.locations = allLocs.map((l) => ({
              name: l.name,
              code: l.code,
              description: l.description,
              parentName: l.parentId ? (idToName.get(l.parentId) ?? null) : null,
              isActive: l.isActive,
            }));
            break;
          }
          case "employees":
          case "shareholders":
          case "lenders":
          case "government": {
            const partyType = PARTY_TYPE_MAP[entity] ?? entity;
            const conditions = [
              eq(parties.organizationId, orgId),
              eq(parties.partyType, partyType as any),
            ];
            if (!includeInactive) conditions.push(eq(parties.isActive, true));
            const idKey = ids?.[entity];
            if (idKey?.length) conditions.push(inArray(parties.id, idKey));

            const rows = await db
              .select({
                name: parties.name,
                partyType: parties.partyType,
                email: parties.email,
                phone: parties.phone,
                website: parties.website,
                address: parties.address,
                paymentTerms: parties.paymentTerms,
                description: parties.description,
                notes: parties.notes,
                isActive: parties.isActive,
              })
              .from(parties)
              .where(and(...conditions))
              .orderBy(asc(parties.name));

            result[entity] = rows;
            break;
          }

          case "products": {
            const conditions = [eq(products.organizationId, orgId)];
            if (!includeInactive) conditions.push(eq(products.isActive, true));
            if (ids?.products?.length) conditions.push(inArray(products.id, ids.products));

            const rows = await db
              .select({
                name: products.name,
                defaultPrice: products.defaultPrice,
                description: products.description,
                isActive: products.isActive,
              })
              .from(products)
              .where(and(...conditions))
              .orderBy(asc(products.name));

            result.products = rows;
            break;
          }

          case "transactions": {
            const hdrConditions = [
              eq(journalHeaders.organizationId, orgId),
              effectiveJournalPredicate(),
            ];
            if (ids?.transactions?.length)
              hdrConditions.push(inArray(journalHeaders.id, ids.transactions));

            const headers = await db
              .select()
              .from(journalHeaders)
              .where(and(...hdrConditions))
              .orderBy(desc(journalHeaders.transactionDate));

            const headerIds = headers.map((h) => h.id);
            const lines =
              headerIds.length > 0
                ? await db
                    .select()
                    .from(journalLines)
                    .where(inArray(journalLines.journalHeaderId, headerIds))
                    .orderBy(asc(journalLines.sortOrder))
                : [];

            // Resolve FKs to names for portability
            const allAccounts = await db
              .select({
                id: accounts.id,
                name: accounts.name,
                accountNumber: accounts.accountNumber,
              })
              .from(accounts)
              .where(eq(accounts.organizationId, orgId));
            const acctMap = new Map(allAccounts.map((a) => [a.id, a]));

            const allParties = await db
              .select({ id: parties.id, name: parties.name })
              .from(parties)
              .where(eq(parties.organizationId, orgId));
            const partyMap = new Map(allParties.map((p) => [p.id, p.name]));

            const allDims = await db
              .select({ id: dimensions.id, name: dimensions.name })
              .from(dimensions)
              .where(eq(dimensions.organizationId, orgId));
            const dimMap = new Map(allDims.map((d) => [d.id, d.name]));

            result.transactions = {
              headers: headers.map((h) => ({
                transactionNumber: h.transactionNumber,
                referenceNumber: h.referenceNumber,
                transactionDate: h.transactionDate,
                transactionType: h.transactionType,
                source: h.source,
                memo: h.memo,
                partyName: h.partyId ? (partyMap.get(h.partyId) ?? null) : null,
                totalAmount: h.totalAmount,
                status: h.status,
              })),
              lines: lines.map((l) => {
                const acct = l.accountId ? acctMap.get(l.accountId) : null;
                return {
                  transactionNumber:
                    headers.find((h) => h.id === l.journalHeaderId)?.transactionNumber ?? null,
                  accountName: acct?.name ?? null,
                  accountNumber: acct?.accountNumber ?? null,
                  debit: l.debit,
                  credit: l.credit,
                  lineDescription: l.lineDescription,
                  partyName: l.partyId ? (partyMap.get(l.partyId) ?? null) : null,
                  departmentName: l.departmentId ? (dimMap.get(l.departmentId) ?? null) : null,
                  locationName: l.locationId ? (dimMap.get(l.locationId) ?? null) : null,
                  sortOrder: l.sortOrder,
                };
              }),
            };
            break;
          }

          case "bills": {
            const bConditions = [eq(bills.organizationId, orgId)];
            if (ids?.bills?.length) bConditions.push(inArray(bills.id, ids.bills));

            const billRows = await db
              .select()
              .from(bills)
              .where(and(...bConditions));
            const billIds = billRows.map((b) => b.id);
            const lineItems =
              billIds.length > 0
                ? await db
                    .select()
                    .from(billLineItems)
                    .where(inArray(billLineItems.billId, billIds))
                : [];

            // Resolve FKs
            const allAccts = await db
              .select({
                id: accounts.id,
                name: accounts.name,
                accountNumber: accounts.accountNumber,
              })
              .from(accounts)
              .where(eq(accounts.organizationId, orgId));
            const aMap = new Map(allAccts.map((a) => [a.id, a]));
            const allPrts = await db
              .select({ id: parties.id, name: parties.name })
              .from(parties)
              .where(eq(parties.organizationId, orgId));
            const pMap = new Map(allPrts.map((p) => [p.id, p.name]));
            const allD = await db
              .select({ id: dimensions.id, name: dimensions.name })
              .from(dimensions)
              .where(eq(dimensions.organizationId, orgId));
            const dMap = new Map(allD.map((d) => [d.id, d.name]));

            result.bills = {
              headers: billRows.map((b) => ({
                billNumber: b.billNumber,
                vendorName: b.vendorId ? (pMap.get(b.vendorId) ?? null) : null,
                billDate: b.billDate,
                dueDate: b.dueDate,
                status: b.status,
                amount: b.amount,
                amountPaid: b.amountPaid,
                balanceDue: b.balanceDue,
                memo: b.memo,
              })),
              lineItems: lineItems.map((li) => {
                const acct = li.accountId ? aMap.get(li.accountId) : null;
                return {
                  billNumber: billRows.find((b) => b.id === li.billId)?.billNumber ?? null,
                  description: li.description,
                  amount: li.amount,
                  accountName: acct?.name ?? null,
                  accountNumber: acct?.accountNumber ?? null,
                  departmentName: li.departmentId ? (dMap.get(li.departmentId) ?? null) : null,
                  locationName: li.locationId ? (dMap.get(li.locationId) ?? null) : null,
                  sortOrder: li.sortOrder,
                };
              }),
            };
            break;
          }

          case "invoices": {
            const iConditions = [eq(invoices.organizationId, orgId)];
            if (ids?.invoices?.length) iConditions.push(inArray(invoices.id, ids.invoices));

            const invRows = await db
              .select()
              .from(invoices)
              .where(and(...iConditions));
            const invIds = invRows.map((i) => i.id);
            const invLineItems =
              invIds.length > 0
                ? await db
                    .select()
                    .from(invoiceLineItems)
                    .where(inArray(invoiceLineItems.invoiceId, invIds))
                : [];

            // Resolve customer names
            const custIds = [...new Set(invRows.map((i) => i.customerId))];
            const custRows =
              custIds.length > 0
                ? await db
                    .select({ id: parties.id, name: parties.name })
                    .from(parties)
                    .where(inArray(parties.id, custIds))
                : [];
            const custMap = new Map(custRows.map((c) => [c.id, c.name]));

            // Resolve account names for line items
            const revAcctIds = [
              ...new Set(invLineItems.map((li) => li.revenueAccountId).filter(Boolean)),
            ] as string[];
            const revAcctRows =
              revAcctIds.length > 0
                ? await db
                    .select({
                      id: accounts.id,
                      name: accounts.name,
                      accountNumber: accounts.accountNumber,
                    })
                    .from(accounts)
                    .where(inArray(accounts.id, revAcctIds))
                : [];
            const revMap = new Map(revAcctRows.map((a) => [a.id, a]));

            result.invoices = {
              headers: invRows.map((inv) => ({
                invoiceNumber: inv.invoiceNumber,
                customerName: custMap.get(inv.customerId) ?? null,
                issueDate: inv.issueDate,
                dueDate: inv.dueDate,
                status: inv.status,
                subtotal: inv.subtotal,
                discountAmount: inv.discountAmount,
                taxAmount: inv.taxAmount,
                total: inv.total,
                amountPaid: inv.amountPaid,
                balanceDue: inv.balanceDue,
                notes: inv.notes,
                paymentTerms: inv.paymentTerms,
              })),
              lineItems: invLineItems.map((li) => {
                const revAcct = li.revenueAccountId ? revMap.get(li.revenueAccountId) : null;
                return {
                  invoiceNumber:
                    invRows.find((inv) => inv.id === li.invoiceId)?.invoiceNumber ?? null,
                  description: li.description,
                  quantity: li.quantity,
                  unitPrice: li.unitPrice,
                  amount: li.amount,
                  revenueAccountName: revAcct?.name ?? null,
                  revenueAccountNumber: revAcct?.accountNumber ?? null,
                  sortOrder: li.sortOrder,
                };
              }),
            };
            break;
          }

          case "numberSequences": {
            const rows = await db.select().from(numberSequences);
            // Scopes are `journal:<orgId>` / `invoice:<orgId>` — the old
            // filter checked startsWith(orgId), which matches NOTHING, so
            // every export silently shipped zero sequences and an import
            // restarted numbering at 1.
            const orgSuffix = `:${orgId}`;
            result.numberSequences = rows
              .filter((r) => r.scope.endsWith(orgSuffix))
              .map((r) => ({
                scope: r.scope.slice(0, -orgSuffix.length),
                currentValue: r.currentValue,
              }));
            break;
          }

          case "orgSettings": {
            const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
            if (org) {
              const meta = (org.metadata ?? {}) as Record<string, unknown>;
              result.orgSettings = [
                {
                  name: org.name,
                  slug: org.slug,
                  currency: meta.currency ?? "USD",
                  phone: meta.phone ?? null,
                  website: meta.website ?? null,
                  taxId: meta.taxId ?? null,
                  addressStreet: meta.addressStreet ?? null,
                  addressCity: meta.addressCity ?? null,
                  addressState: meta.addressState ?? null,
                  addressPostalCode: meta.addressPostalCode ?? null,
                  addressCountry: meta.addressCountry ?? null,
                  logoUrl: meta.logoUrl ?? null,
                },
              ];
            }
            break;
          }
        }
      }

      // Fetch org info for meta block
      const [orgRow] = await db
        .select({ name: organization.name, slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, orgId));

      const meta: ExportMeta = {
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        organizationName: orgRow?.name ?? "Unknown",
        organizationSlug: orgRow?.slug ?? "unknown",
        entities,
      };

      return { meta, data: result } satisfies VersionedExportFile;
    });
  },
);

// ============================================================================
// Validate Import
// ============================================================================

const validateImportSchema = z.object({
  entityType: z.enum(ENTITY_ENUM),
  content: z.string(),
  format: z.enum(["json", "csv"]).default("json"),
});

// Per-entity row validation schemas
const bankRowSchema = z.object({
  accountName: z.string().min(1, "Account name is required"),
  institutionName: z.string().optional().nullable(),
  accountType: z.enum([
    "checking",
    "savings",
    "credit_card",
    "money_market",
    "investment",
    "other",
  ]),
  lastFour: z.string().max(4).optional().nullable(),
  isManual: z.boolean().optional().default(true),
  connectionStatus: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  accountNumber: z.string().optional().nullable(),
  routingNumber: z.string().optional().nullable(),
  swiftCode: z.string().optional().nullable(),
  iban: z.string().optional().nullable(),
  ledgerAccountNumber: z.string().optional().nullable(),
  ledgerAccountName: z.string().optional().nullable(),
});

const vendorRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  partyType: z.enum(["vendor", "customer", "both"]).optional().default("vendor"),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .nullable(),
  is1099Vendor: z.boolean().optional().default(false),
  taxId: z.string().optional().nullable(),
  bankRoutingNumber: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  mailingAddress: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .nullable(),
  paymentTerms: z.string().optional().nullable(),
  creditLimit: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  defaultAccountNumber: z.string().optional().nullable(),
  defaultAccountName: z.string().optional().nullable(),
});

const customerRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  partyType: z.enum(["vendor", "customer", "both"]).optional().default("customer"),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .nullable(),
  paymentTerms: z.string().optional().nullable(),
  creditLimit: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  bankRoutingNumber: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  mailingAddress: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  defaultAccountNumber: z.string().optional().nullable(),
  defaultAccountName: z.string().optional().nullable(),
});

const categoryRowSchema = z.object({
  accountNumber: z.string().optional().nullable(),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional().nullable(),
  accountType: z.string().min(1, "Account type is required"),
  subtype: z.string().optional().nullable(),
  parentName: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  status: z.string().optional().default("active"),
  isActive: z.boolean().optional().default(true),
});

const departmentRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  code: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  parentName: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const locationRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  code: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  parentName: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

// Reuse vendorRowSchema for party types that share the same shape
const partyRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  partyType: z.string().optional(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .nullable(),
  paymentTerms: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const productRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  defaultPrice: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

function getRowSchema(entityType: string) {
  switch (entityType) {
    case "banks":
      return bankRowSchema;
    case "vendors":
      return vendorRowSchema;
    case "customers":
      return customerRowSchema;
    case "employees":
    case "shareholders":
    case "lenders":
    case "government":
      return partyRowSchema;
    case "categories":
      return categoryRowSchema;
    case "departments":
      return departmentRowSchema;
    case "locations":
      return locationRowSchema;
    case "products":
      return productRowSchema;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

// Simple CSV parser
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsvContent(content: string): Record<string, any>[] {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, any>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, any> = {};
    headers.forEach((h, idx) => {
      const val = values[idx] ?? "";
      // Auto-parse booleans
      if (val.toLowerCase() === "true") row[h] = true;
      else if (val.toLowerCase() === "false") row[h] = false;
      else row[h] = val || null;
    });
    rows.push(row);
  }
  return rows;
}

export const validateImport = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    // Validation is read-only, but it was the ONLY function in this module
    // with no auth at all — an anonymous JSON/CSV parsing endpoint.
    return withSessionOrgContext(async () => {
      const { entityType, content, format } = validateImportSchema.parse(rawData);
      const schema = getRowSchema(entityType);

      let rows: Record<string, any>[];
      if (format === "csv") {
        rows = parseCsvContent(content);
      } else {
        const parsed = JSON.parse(content);
        // Support v2 format { meta, data: { type: [...] } }, v1 format { entities: { type: [...] } }, or flat array
        if (Array.isArray(parsed)) {
          rows = parsed;
        } else if (parsed?.data?.[entityType]) {
          rows = Array.isArray(parsed.data[entityType]) ? parsed.data[entityType] : [];
        } else if (parsed?.entities?.[entityType]) {
          rows = parsed.entities[entityType];
        } else {
          rows = [];
        }
      }

      const validated: Array<{
        row: number;
        valid: boolean;
        data?: Record<string, any>;
        errors?: string[];
      }> = [];

      for (let i = 0; i < rows.length; i++) {
        const result = schema.safeParse(rows[i]);
        if (result.success) {
          validated.push({ row: i + 1, valid: true, data: result.data as Record<string, any> });
        } else {
          validated.push({
            row: i + 1,
            valid: false,
            errors: result.error.issues.map((e) => `${String(e.path.join("."))}: ${e.message}`),
          });
        }
      }

      return {
        entityType,
        total: rows.length,
        valid: validated.filter((v) => v.valid).length,
        invalid: validated.filter((v) => !v.valid).length,
        rows: validated,
      };
    });
  },
);

// ============================================================================
// Execute Import
// ============================================================================

const executeImportSchema = z.object({
  entityType: z.enum(ENTITY_ENUM),
  rows: z.array(z.record(z.string(), z.any())),
});

export const executeImport = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "export-import:execute", limit: 10, windowMs: 300_000 },
      async ({ orgId, db }) => {
        const { entityType, rows: rawRows } = executeImportSchema.parse(rawData);

        const results: Array<{
          name: string;
          success: boolean;
          error?: string;
        }> = [];

        // Validation used to be ADVISORY: validateImport checked the rows,
        // but execute inserted whatever the client sent (audit, tenancy /
        // export-import — rules doc "Common Mistake #3" family). Every row
        // is now parsed against the entity schema; invalid rows fail
        // individually with their row number, valid rows proceed with
        // schema defaults applied.
        const rowSchema = getRowSchema(entityType);
        const rows: Record<string, any>[] = [];
        for (const [index, raw] of rawRows.entries()) {
          const parsed = rowSchema.safeParse(raw);
          if (parsed.success) {
            rows.push(parsed.data as Record<string, any>);
          } else {
            results.push({
              name: String(raw.name ?? raw.accountName ?? `row ${index + 1}`),
              success: false,
              error: `Row ${index + 1}: ${parsed.error.issues
                .map((issue) => `${String(issue.path.join("."))}: ${issue.message}`)
                .join("; ")}`,
            });
          }
        }

        /** Resolve an org-owned ledger account by number, then name. */
        const resolveAccountRef = async (
          number: string | null | undefined,
          name: string | null | undefined,
        ): Promise<string | null> => {
          if (number) {
            const [byNumber] = await db
              .select({ id: accounts.id })
              .from(accounts)
              .where(and(eq(accounts.organizationId, orgId), eq(accounts.accountNumber, number)))
              .limit(1);
            if (byNumber) return byNumber.id;
          }
          if (name) {
            const [byName] = await db
              .select({ id: accounts.id })
              .from(accounts)
              .where(and(eq(accounts.organizationId, orgId), eq(accounts.name, name)))
              .limit(1);
            if (byName) return byName.id;
          }
          return null;
        };

        switch (entityType) {
          case "banks": {
            for (const row of rows) {
              try {
                // Duplicate check
                const existing = await db
                  .select({ id: financialAccounts.id })
                  .from(financialAccounts)
                  .where(
                    and(
                      eq(financialAccounts.organizationId, orgId),
                      eq(financialAccounts.accountName, row.accountName),
                      eq(financialAccounts.accountType, row.accountType),
                    ),
                  )
                  .limit(1);

                if (existing.length > 0) {
                  results.push({
                    name: row.accountName,
                    success: true,
                    error: "Duplicate (skipped)",
                  });
                  continue;
                }

                await db.insert(financialAccounts).values({
                  organizationId: orgId,
                  accountName: row.accountName,
                  institutionName: row.institutionName || null,
                  accountType: row.accountType,
                  lastFour: row.lastFour || null,
                  isManual: row.isManual ?? true,
                  connectionStatus: "disconnected",
                  isActive: row.isActive ?? true,
                  accountNumber: row.accountNumber || null,
                  routingNumber: row.routingNumber || null,
                  swiftCode: row.swiftCode || null,
                  iban: row.iban || null,
                  ledgerAccountId: await resolveAccountRef(
                    row.ledgerAccountNumber,
                    row.ledgerAccountName,
                  ),
                });
                results.push({ name: row.accountName, success: true });
              } catch (err) {
                results.push({
                  name: row.accountName,
                  success: false,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }
            break;
          }

          case "vendors":
          case "customers": {
            const defaultType = entityType === "vendors" ? "vendor" : "customer";
            for (const row of rows) {
              try {
                const pType = row.partyType || defaultType;
                const existing = await db
                  .select({ id: parties.id })
                  .from(parties)
                  .where(and(eq(parties.organizationId, orgId), eq(parties.name, row.name)))
                  .limit(1);

                if (existing.length > 0) {
                  results.push({ name: row.name, success: true, error: "Duplicate (skipped)" });
                  continue;
                }

                await db.insert(parties).values({
                  organizationId: orgId,
                  name: row.name,
                  partyType: pType,
                  email: row.email || null,
                  phone: row.phone || null,
                  website: row.website || null,
                  address: row.address || null,
                  is1099Vendor: row.is1099Vendor ?? false,
                  taxId: row.taxId || null,
                  bankRoutingNumber: row.bankRoutingNumber || null,
                  bankAccountNumber: row.bankAccountNumber || null,
                  mailingAddress: row.mailingAddress || null,
                  paymentTerms: row.paymentTerms || null,
                  creditLimit: row.creditLimit || null,
                  description: row.description || null,
                  notes: row.notes || null,
                  isActive: row.isActive ?? true,
                  defaultAccountId: await resolveAccountRef(
                    row.defaultAccountNumber,
                    row.defaultAccountName,
                  ),
                });
                results.push({ name: row.name, success: true });
              } catch (err) {
                results.push({
                  name: row.name,
                  success: false,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }
            break;
          }

          case "categories": {
            // Two-pass: create without parents, then link parents
            const nameToId = new Map<string, string>();

            // Pass 1: Insert
            for (const row of rows) {
              try {
                const existing = row.accountNumber
                  ? await db
                      .select({ id: accounts.id })
                      .from(accounts)
                      .where(
                        and(
                          eq(accounts.organizationId, orgId),
                          eq(accounts.accountNumber, row.accountNumber),
                        ),
                      )
                      .limit(1)
                  : await db
                      .select({ id: accounts.id })
                      .from(accounts)
                      .where(and(eq(accounts.organizationId, orgId), eq(accounts.name, row.name)))
                      .limit(1);

                if (existing.length > 0) {
                  nameToId.set(row.name, existing[0].id);
                  results.push({ name: row.name, success: true, error: "Duplicate (skipped)" });
                  continue;
                }

                const [created] = await db
                  .insert(accounts)
                  .values({
                    organizationId: orgId,
                    name: row.name,
                    accountNumber: row.accountNumber || undefined,
                    description: row.description || null,
                    accountType: row.accountType,
                    subtype: row.subtype || null,
                    icon: row.icon || null,
                    status: row.status || "active",
                    isActive: row.isActive ?? true,
                  })
                  .returning({ id: accounts.id });

                nameToId.set(row.name, created.id);
                results.push({ name: row.name, success: true });
              } catch (err) {
                results.push({
                  name: row.name,
                  success: false,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }

            // Pass 2: Link parents
            for (const row of rows) {
              if (!row.parentName) continue;
              const childId = nameToId.get(row.name);
              const parentId = nameToId.get(row.parentName);
              if (childId && parentId) {
                await db.update(accounts).set({ parentId }).where(eq(accounts.id, childId));
              }
            }
            break;
          }

          case "departments":
          case "locations": {
            const dimType = entityType === "departments" ? "department" : "location";
            const nameToId = new Map<string, string>();

            // Pass 1: Insert
            for (const row of rows) {
              try {
                const existing = await db
                  .select({ id: dimensions.id })
                  .from(dimensions)
                  .where(
                    and(
                      eq(dimensions.organizationId, orgId),
                      eq(dimensions.dimensionType, dimType),
                      eq(dimensions.name, row.name),
                    ),
                  )
                  .limit(1);

                if (existing.length > 0) {
                  nameToId.set(row.name, existing[0].id);
                  results.push({ name: row.name, success: true, error: "Duplicate (skipped)" });
                  continue;
                }

                const [created] = await db
                  .insert(dimensions)
                  .values({
                    organizationId: orgId,
                    dimensionType: dimType,
                    name: row.name,
                    code: row.code || null,
                    description: row.description || null,
                    isActive: row.isActive ?? true,
                  })
                  .returning({ id: dimensions.id });

                nameToId.set(row.name, created.id);
                results.push({ name: row.name, success: true });
              } catch (err) {
                results.push({
                  name: row.name,
                  success: false,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }

            // Pass 2: Link parents
            for (const row of rows) {
              if (!row.parentName) continue;
              const childId = nameToId.get(row.name);
              const parentId = nameToId.get(row.parentName);
              if (childId && parentId) {
                await db.update(dimensions).set({ parentId }).where(eq(dimensions.id, childId));
              }
            }
            break;
          }
          case "employees":
          case "shareholders":
          case "lenders":
          case "government": {
            const partyType = PARTY_TYPE_MAP[entityType] ?? entityType;
            for (const row of rows) {
              try {
                const existing = await db
                  .select({ id: parties.id })
                  .from(parties)
                  .where(and(eq(parties.organizationId, orgId), eq(parties.name, row.name)))
                  .limit(1);

                if (existing.length > 0) {
                  results.push({ name: row.name, success: true, error: "Duplicate (skipped)" });
                  continue;
                }

                await db.insert(parties).values({
                  organizationId: orgId,
                  name: row.name,
                  partyType: partyType as any,
                  email: row.email || null,
                  phone: row.phone || null,
                  website: row.website || null,
                  address: row.address || null,
                  paymentTerms: row.paymentTerms || null,
                  description: row.description || null,
                  notes: row.notes || null,
                  isActive: row.isActive ?? true,
                });
                results.push({ name: row.name, success: true });
              } catch (err) {
                results.push({
                  name: row.name,
                  success: false,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }
            break;
          }

          case "products": {
            for (const row of rows) {
              try {
                const existing = await db
                  .select({ id: products.id })
                  .from(products)
                  .where(and(eq(products.organizationId, orgId), eq(products.name, row.name)))
                  .limit(1);

                if (existing.length > 0) {
                  results.push({ name: row.name, success: true, error: "Duplicate (skipped)" });
                  continue;
                }

                await db.insert(products).values({
                  organizationId: orgId,
                  name: row.name,
                  defaultPrice: row.defaultPrice || "0",
                  description: row.description || null,
                  isActive: row.isActive ?? true,
                });
                results.push({ name: row.name, success: true });
              } catch (err) {
                results.push({
                  name: row.name,
                  success: false,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }
            break;
          }

          // Transactions, bills, invoices, numberSequences, orgSettings
          // are read-only exports for now — import is not yet supported
          case "transactions":
          case "bills":
          case "invoices":
          case "numberSequences":
          case "orgSettings": {
            // These entity types are export-only for now
            break;
          }
        }

        return {
          imported: results.filter((r) => r.success && !r.error?.includes("skipped")).length,
          skipped: results.filter((r) => r.error?.includes("skipped")).length,
          failed: results.filter((r) => !r.success).length,
          results,
        };
      },
    ) as any;
  },
);

// ============================================================================
// List records for cherry-pick (lightweight: id + display name only)
// ============================================================================

const listExportableSchema = z.object({
  entityType: z.enum(ENTITY_ENUM),
  includeInactive: z.boolean().default(false),
});

export const listExportableRecords = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    // report:export is withheld from member and clientApprover. Gating on
    // the session alone let either role export the organization's books,
    // which is the one thing that grant exists to prevent.
    return withPermissionOrgContext("report", "export", async ({ orgId, db }) => {
      const { entityType, includeInactive } = listExportableSchema.parse(rawData);

      switch (entityType) {
        case "banks": {
          const conditions = [eq(financialAccounts.organizationId, orgId)];
          if (!includeInactive) conditions.push(eq(financialAccounts.isActive, true));
          return await db
            .select({
              id: financialAccounts.id,
              name: financialAccounts.accountName,
              subtitle: financialAccounts.accountType,
              extra: financialAccounts.lastFour,
            })
            .from(financialAccounts)
            .where(and(...conditions))
            .orderBy(asc(financialAccounts.accountName));
        }

        case "vendors": {
          const conditions = [
            eq(parties.organizationId, orgId),
            or(eq(parties.partyType, "vendor"), eq(parties.partyType, "both"))!,
          ];
          if (!includeInactive) conditions.push(eq(parties.isActive, true));
          return await db
            .select({
              id: parties.id,
              name: parties.name,
              subtitle: parties.email,
              extra: parties.phone,
            })
            .from(parties)
            .where(and(...conditions))
            .orderBy(asc(parties.name));
        }

        case "customers": {
          const conditions = [
            eq(parties.organizationId, orgId),
            or(eq(parties.partyType, "customer"), eq(parties.partyType, "both"))!,
          ];
          if (!includeInactive) conditions.push(eq(parties.isActive, true));
          return await db
            .select({
              id: parties.id,
              name: parties.name,
              subtitle: parties.email,
              extra: parties.phone,
            })
            .from(parties)
            .where(and(...conditions))
            .orderBy(asc(parties.name));
        }

        case "categories": {
          const conditions = [eq(accounts.organizationId, orgId)];
          if (!includeInactive) conditions.push(eq(accounts.isActive, true));
          return await db
            .select({
              id: accounts.id,
              name: accounts.name,
              subtitle: accounts.accountType,
              extra: accounts.accountNumber,
            })
            .from(accounts)
            .where(and(...conditions))
            .orderBy(asc(accounts.accountNumber), asc(accounts.name));
        }

        case "departments": {
          const conditions = [
            eq(dimensions.organizationId, orgId),
            eq(dimensions.dimensionType, "department"),
          ];
          if (!includeInactive) conditions.push(eq(dimensions.isActive, true));
          return await db
            .select({
              id: dimensions.id,
              name: dimensions.name,
              subtitle: dimensions.code,
              extra: dimensions.description,
            })
            .from(dimensions)
            .where(and(...conditions))
            .orderBy(asc(dimensions.name));
        }

        case "locations": {
          const conditions = [
            eq(dimensions.organizationId, orgId),
            eq(dimensions.dimensionType, "location"),
          ];
          if (!includeInactive) conditions.push(eq(dimensions.isActive, true));
          return await db
            .select({
              id: dimensions.id,
              name: dimensions.name,
              subtitle: dimensions.code,
              extra: dimensions.description,
            })
            .from(dimensions)
            .where(and(...conditions))
            .orderBy(asc(dimensions.name));
        }

        case "employees":
        case "shareholders":
        case "lenders":
        case "government": {
          const pType = PARTY_TYPE_MAP[entityType] ?? entityType;
          const conditions = [
            eq(parties.organizationId, orgId),
            eq(parties.partyType, pType as any),
          ];
          if (!includeInactive) conditions.push(eq(parties.isActive, true));
          return await db
            .select({
              id: parties.id,
              name: parties.name,
              subtitle: parties.email,
              extra: parties.phone,
            })
            .from(parties)
            .where(and(...conditions))
            .orderBy(asc(parties.name));
        }

        case "products": {
          const conditions = [eq(products.organizationId, orgId)];
          if (!includeInactive) conditions.push(eq(products.isActive, true));
          return await db
            .select({
              id: products.id,
              name: products.name,
              subtitle: products.defaultPrice,
              extra: products.description,
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(asc(products.name));
        }

        case "transactions": {
          const conditions = [
            eq(journalHeaders.organizationId, orgId),
            effectiveJournalPredicate(),
          ];
          return await db
            .select({
              id: journalHeaders.id,
              name: journalHeaders.transactionNumber,
              subtitle: journalHeaders.transactionType,
              extra: journalHeaders.totalAmount,
            })
            .from(journalHeaders)
            .where(and(...conditions))
            .orderBy(desc(journalHeaders.transactionDate));
        }

        case "bills": {
          const conditions = [eq(bills.organizationId, orgId)];
          return await db
            .select({
              id: bills.id,
              name: bills.billNumber,
              subtitle: bills.status,
              extra: bills.amount,
            })
            .from(bills)
            .where(and(...conditions))
            .orderBy(desc(bills.billDate));
        }

        case "invoices": {
          const conditions = [eq(invoices.organizationId, orgId)];
          return await db
            .select({
              id: invoices.id,
              name: invoices.invoiceNumber,
              subtitle: invoices.status,
              extra: invoices.total,
            })
            .from(invoices)
            .where(and(...conditions))
            .orderBy(desc(invoices.issueDate));
        }

        // Number sequences and org settings don't have cherry-pick
        default:
          return [];
      }
    });
  },
);
