import { createServerFn } from "@tanstack/react-start";
import { financialAccounts } from "../../db/schema/financial-accounts";
import { financialAccountSecrets } from "../../db/schema/financial-account-secrets";
import { accounts } from "../../db/schema/accounts";
import { asc, eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { ilike } from "drizzle-orm";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { setStatementPassword, clearStatementPassword } from "../../lib/financial-account-secrets";

// ============================================================================
// Types
// ============================================================================

export type FinancialAccountRecord = typeof financialAccounts.$inferSelect;

// Helper: resolve R2 key → presigned download URL for institutionLogoUrl
async function resolveInstitutionLogoUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  const { getPresignedDownloadUrl } = await import("../../lib/storage");
  return getPresignedDownloadUrl(url, { expiresIn: 60 * 60 * 24 });
}

// ============================================================================
// List Financial Accounts
// ============================================================================

const listFinancialAccountsSchema = z.object({
  type: z
    .enum(["checking", "savings", "credit_card", "money_market", "investment", "other", "all"])
    .optional(),
  search: z.string().optional(),
  limit: z.number().optional().default(100),
});

export const listFinancialAccounts = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listFinancialAccountsSchema>) =>
    listFinancialAccountsSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { type, search, limit } = listFinancialAccountsSchema.parse(rawData ?? {});

      const conditions = [
        eq(financialAccounts.isActive, true),
        eq(financialAccounts.organizationId, orgId),
      ];

      if (type && type !== "all") {
        conditions.push(eq(financialAccounts.accountType, type));
      }

      if (search) {
        conditions.push(ilike(financialAccounts.accountName, `%${search}%`));
      }

      let query = db
        .select({
          id: financialAccounts.id,
          accountName: financialAccounts.accountName,
          institutionName: financialAccounts.institutionName,
          institutionLogoUrl: financialAccounts.institutionLogoUrl,
          accountType: financialAccounts.accountType,
          lastFour: financialAccounts.lastFour,
          ledgerAccountId: financialAccounts.ledgerAccountId,
          isManual: financialAccounts.isManual,
          connectionStatus: financialAccounts.connectionStatus,
          isActive: financialAccounts.isActive,
          isOwned: financialAccounts.isOwned,
          accountNumber: financialAccounts.accountNumber,
          routingNumber: financialAccounts.routingNumber,
          swiftCode: financialAccounts.swiftCode,
          iban: financialAccounts.iban,
          qrCodeUrl: financialAccounts.qrCodeUrl,
          showOnPaymentLink: financialAccounts.showOnPaymentLink,
          lastSyncedAt: financialAccounts.lastSyncedAt,
          createdAt: financialAccounts.createdAt,
          updatedAt: financialAccounts.updatedAt,
          ledgerAccountName: accounts.name,
          ledgerAccountType: accounts.accountType,
          statementPasswordSet: sql<boolean>`${financialAccountSecrets.financialAccountId} IS NOT NULL`,
        })
        .from(financialAccounts)
        .leftJoin(accounts, eq(financialAccounts.ledgerAccountId, accounts.id))
        .leftJoin(
          financialAccountSecrets,
          eq(financialAccountSecrets.financialAccountId, financialAccounts.id),
        )
        .where(and(...conditions))
        .orderBy(asc(financialAccounts.accountName))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      const results = await query;

      return Promise.all(
        results.map(async (account) => ({
          ...account,
          institutionLogoUrl: await resolveInstitutionLogoUrl(account.institutionLogoUrl),
        })),
      );
    });
  });

// ============================================================================
// Get Single Financial Account
// ============================================================================

const getFinancialAccountSchema = z.object({
  id: z.string().uuid(),
});

export const getFinancialAccount = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getFinancialAccountSchema>) =>
    getFinancialAccountSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { id } = getFinancialAccountSchema.parse(rawData);

      const [account] = await db
        .select({
          id: financialAccounts.id,
          accountName: financialAccounts.accountName,
          institutionName: financialAccounts.institutionName,
          institutionLogoUrl: financialAccounts.institutionLogoUrl,
          accountType: financialAccounts.accountType,
          lastFour: financialAccounts.lastFour,
          ledgerAccountId: financialAccounts.ledgerAccountId,
          isManual: financialAccounts.isManual,
          connectionStatus: financialAccounts.connectionStatus,
          connectionId: financialAccounts.connectionId,
          integrationSource: financialAccounts.integrationSource,
          externalAccountId: financialAccounts.externalAccountId,
          isActive: financialAccounts.isActive,
          isOwned: financialAccounts.isOwned,
          accountNumber: financialAccounts.accountNumber,
          routingNumber: financialAccounts.routingNumber,
          swiftCode: financialAccounts.swiftCode,
          iban: financialAccounts.iban,
          qrCodeUrl: financialAccounts.qrCodeUrl,
          showOnPaymentLink: financialAccounts.showOnPaymentLink,
          lastSyncedAt: financialAccounts.lastSyncedAt,
          createdAt: financialAccounts.createdAt,
          updatedAt: financialAccounts.updatedAt,
          ledgerAccountName: accounts.name,
          ledgerAccountType: accounts.accountType,
          statementPasswordSet: sql<boolean>`${financialAccountSecrets.financialAccountId} IS NOT NULL`,
        })
        .from(financialAccounts)
        .leftJoin(accounts, eq(financialAccounts.ledgerAccountId, accounts.id))
        .leftJoin(
          financialAccountSecrets,
          eq(financialAccountSecrets.financialAccountId, financialAccounts.id),
        )
        .where(and(eq(financialAccounts.id, id), eq(financialAccounts.organizationId, orgId)))
        .limit(1);

      if (!account) throw new Error("Financial account not found");
      return {
        ...account,
        accountNumber: account.accountNumber ?? null,
        routingNumber: account.routingNumber ?? null,
        swiftCode: account.swiftCode ?? null,
        iban: account.iban ?? null,
        qrCodeUrl: account.qrCodeUrl ?? null,
        showOnPaymentLink: account.showOnPaymentLink ?? false,
        isOwned: account.isOwned ?? false,
        institutionLogoUrl: await resolveInstitutionLogoUrl(account.institutionLogoUrl),
      };
    });
  });

// ============================================================================
// Create Financial Account
// ============================================================================

const createFinancialAccountSchema = z.object({
  accountName: z.string().min(1, "Account name is required"),
  institutionName: z.string().optional(),
  institutionLogoUrl: z.string().optional(),
  accountType: z.enum([
    "checking",
    "savings",
    "credit_card",
    "money_market",
    "investment",
    "other",
  ]),
  lastFour: z.string().max(4).optional(),
  ledgerAccountId: z.string().uuid().optional().nullable(),
  isOwned: z.boolean().optional().default(false),
});

export const createFinancialAccount = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "financialAccount",
      "create",
      { routeKey: "financial-account:create", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createFinancialAccountSchema.parse(rawData);

        const [account] = await db
          .insert(financialAccounts)
          .values({
            organizationId: orgId,
            accountName: parsed.accountName,
            institutionName: parsed.institutionName || null,
            institutionLogoUrl: parsed.institutionLogoUrl || null,
            accountType: parsed.accountType,
            lastFour: parsed.lastFour || null,
            ledgerAccountId: parsed.ledgerAccountId || null,
            isManual: true,
            connectionStatus: "disconnected",
            isActive: true,
            isOwned: parsed.isOwned ?? false,
          })
          .returning();

        return account;
      },
    );
  },
);

// ============================================================================
// Update Financial Account
// ============================================================================

const updateFinancialAccountSchema = z.object({
  id: z.string().uuid(),
  accountName: z.string().min(1).optional(),
  institutionName: z.string().optional().nullable(),
  institutionLogoUrl: z.string().optional().nullable(),
  accountType: z
    .enum(["checking", "savings", "credit_card", "money_market", "investment", "other"])
    .optional(),
  lastFour: z.string().max(4).optional().nullable(),
  ledgerAccountId: z.string().uuid().optional().nullable(),
  // Wire / payment display fields
  accountNumber: z.string().max(50).optional().nullable(),
  routingNumber: z.string().max(20).optional().nullable(),
  swiftCode: z.string().max(15).optional().nullable(),
  iban: z.string().max(50).optional().nullable(),
  qrCodeUrl: z.string().max(500).optional().nullable(),
  showOnPaymentLink: z.boolean().optional(),
  isOwned: z.boolean().optional(),
});

export const updateFinancialAccount = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "financialAccount",
      "update",
      { routeKey: "financial-account:update", limit: 45, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = updateFinancialAccountSchema.parse(rawData);
        const { id, ...updates } = parsed;

        const updateFields: Record<string, unknown> = { updatedAt: new Date() };
        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            updateFields[key] = value;
          }
        }

        const [updated] = await db
          .update(financialAccounts)
          .set(updateFields)
          .where(and(eq(financialAccounts.id, id), eq(financialAccounts.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  },
);

// ============================================================================
// Statement PDF Password (encrypted, server-only)
// ============================================================================

const setStatementPasswordSchema = z.object({
  id: z.string().uuid(),
  // null / empty clears any stored password.
  password: z.string().max(256).nullable(),
});

/**
 * Store or clear a bank account's statement PDF password. The value is
 * encrypted at rest and never returned to the client — reads expose only the
 * boolean `statementPasswordSet`.
 */
export const setFinancialAccountStatementPassword = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "financialAccount",
      "update",
      { routeKey: "financial-account:statement-password", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id, password } = setStatementPasswordSchema.parse(rawData);

        // The account must belong to this org before we touch its secrets.
        const [account] = await db
          .select({ id: financialAccounts.id })
          .from(financialAccounts)
          .where(and(eq(financialAccounts.id, id), eq(financialAccounts.organizationId, orgId)))
          .limit(1);
        if (!account) throw new Error("Financial account not found");

        const trimmed = password?.trim();
        if (trimmed) {
          await setStatementPassword(db, orgId, id, trimmed);
          return { statementPasswordSet: true };
        }
        await clearStatementPassword(db, id);
        return { statementPasswordSet: false };
      },
    );
  },
);

// ============================================================================
// Upload Financial Account Avatar
// ============================================================================

const MAX_BASE64_SIZE = Math.ceil(5 * 1024 * 1024 * 1.4); // ~5 MB file → ~7 MB base64

const uploadFinancialAccountAvatarSchema = z.object({
  accountId: z.string().uuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  fileBase64: z.string().min(1).max(MAX_BASE64_SIZE, "File exceeds maximum allowed size"),
});

export const uploadFinancialAccountAvatar = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "financialAccount",
      "update",
      { routeKey: "financial-account:avatar-upload", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { accountId, filename, contentType, fileBase64 } =
          uploadFinancialAccountAvatarSchema.parse(rawData);

        const { uploadToR2, getPresignedDownloadUrl } = await import("../../lib/storage");

        const ext = filename.split(".").pop() ?? "png";
        const key = `${orgId}/entities/banks/${accountId}.${ext}`;

        const buffer = Buffer.from(fileBase64, "base64");
        await uploadToR2(key, buffer, contentType);

        await db
          .update(financialAccounts)
          .set({ institutionLogoUrl: key, updatedAt: new Date() })
          .where(
            and(eq(financialAccounts.id, accountId), eq(financialAccounts.organizationId, orgId)),
          );

        const institutionLogoUrl = await getPresignedDownloadUrl(key, {
          expiresIn: 60 * 60 * 24,
        });

        return { institutionLogoUrl, r2Key: key };
      },
    );
  },
);

// ============================================================================
// Delete Financial Account (soft delete)
// ============================================================================

const deleteFinancialAccountSchema = z.object({
  id: z.string().uuid(),
});

export const deleteFinancialAccount = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "financialAccount",
      "delete",
      { routeKey: "financial-account:delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { id } = deleteFinancialAccountSchema.parse(rawData);

        const [existing] = await db
          .select()
          .from(financialAccounts)
          .where(and(eq(financialAccounts.id, id), eq(financialAccounts.organizationId, orgId)))
          .limit(1);

        if (!existing) throw new Error("Financial account not found");

        const [updated] = await db
          .update(financialAccounts)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(eq(financialAccounts.id, id), eq(financialAccounts.organizationId, orgId)))
          .returning();

        return updated;
      },
    );
  },
);
