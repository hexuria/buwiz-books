import { relations } from "drizzle-orm/relations";
import {
  accounts,
  dimensions,
  invoices,
  invoiceLineItems,
  parties,
  financialAccounts,
  reconciliations,
  documents,
  documentAttachments,
  bankTransactions,
  categoryConnections,
  bills,
  billLineItems,
  authUsers,
  authAccounts,
  authMembers,
  authOrganizations,
  authInvitations,
  journalHeaders,
  authSessions,
  journalLines,
  statementLines,
  reconciliationFlags,
  documentSuggestions,
} from "./schema";

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  account: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
    relationName: "accounts_parentId_accounts_id",
  }),
  accounts: many(accounts, {
    relationName: "accounts_parentId_accounts_id",
  }),
  invoiceLineItems: many(invoiceLineItems),
  parties: many(parties),
  financialAccounts: many(financialAccounts),
  categoryConnections: many(categoryConnections),
  billLineItems: many(billLineItems),
  journalLines: many(journalLines),
}));

export const dimensionsRelations = relations(dimensions, ({ one, many }) => ({
  dimension: one(dimensions, {
    fields: [dimensions.parentId],
    references: [dimensions.id],
    relationName: "dimensions_parentId_dimensions_id",
  }),
  dimensions: many(dimensions, {
    relationName: "dimensions_parentId_dimensions_id",
  }),
  billLineItems_departmentId: many(billLineItems, {
    relationName: "billLineItems_departmentId_dimensions_id",
  }),
  billLineItems_locationId: many(billLineItems, {
    relationName: "billLineItems_locationId_dimensions_id",
  }),
  journalLines_departmentId: many(journalLines, {
    relationName: "journalLines_departmentId_dimensions_id",
  }),
  journalLines_locationId: many(journalLines, {
    relationName: "journalLines_locationId_dimensions_id",
  }),
}));

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLineItems.invoiceId],
    references: [invoices.id],
  }),
  account: one(accounts, {
    fields: [invoiceLineItems.revenueAccountId],
    references: [accounts.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  invoiceLineItems: many(invoiceLineItems),
  party: one(parties, {
    fields: [invoices.customerId],
    references: [parties.id],
  }),
  journalHeader: one(journalHeaders, {
    fields: [invoices.journalHeaderId],
    references: [journalHeaders.id],
  }),
}));

export const partiesRelations = relations(parties, ({ one, many }) => ({
  account: one(accounts, {
    fields: [parties.defaultAccountId],
    references: [accounts.id],
  }),
  journalHeaders: many(journalHeaders),
  bills: many(bills),
  invoices: many(invoices),
}));

export const financialAccountsRelations = relations(financialAccounts, ({ one, many }) => ({
  account: one(accounts, {
    fields: [financialAccounts.ledgerAccountId],
    references: [accounts.id],
  }),
  reconciliations: many(reconciliations),
  bankTransactions: many(bankTransactions),
}));

export const reconciliationsRelations = relations(reconciliations, ({ one, many }) => ({
  financialAccount: one(financialAccounts, {
    fields: [reconciliations.bankAccountId],
    references: [financialAccounts.id],
  }),
  statementLines: many(statementLines),
  reconciliationFlags: many(reconciliationFlags),
}));

export const documentAttachmentsRelations = relations(documentAttachments, ({ one }) => ({
  document: one(documents, {
    fields: [documentAttachments.documentId],
    references: [documents.id],
  }),
}));

export const documentsRelations = relations(documents, ({ many }) => ({
  documentAttachments: many(documentAttachments),
  documentSuggestions: many(documentSuggestions),
}));

export const bankTransactionsRelations = relations(bankTransactions, ({ one }) => ({
  financialAccount: one(financialAccounts, {
    fields: [bankTransactions.financialAccountId],
    references: [financialAccounts.id],
  }),
}));

export const categoryConnectionsRelations = relations(categoryConnections, ({ one }) => ({
  account: one(accounts, {
    fields: [categoryConnections.categoryId],
    references: [accounts.id],
  }),
}));

export const billLineItemsRelations = relations(billLineItems, ({ one }) => ({
  bill: one(bills, {
    fields: [billLineItems.billId],
    references: [bills.id],
  }),
  account: one(accounts, {
    fields: [billLineItems.accountId],
    references: [accounts.id],
  }),
  dimension_departmentId: one(dimensions, {
    fields: [billLineItems.departmentId],
    references: [dimensions.id],
    relationName: "billLineItems_departmentId_dimensions_id",
  }),
  dimension_locationId: one(dimensions, {
    fields: [billLineItems.locationId],
    references: [dimensions.id],
    relationName: "billLineItems_locationId_dimensions_id",
  }),
}));

export const billsRelations = relations(bills, ({ one, many }) => ({
  billLineItems: many(billLineItems),
  party: one(parties, {
    fields: [bills.vendorId],
    references: [parties.id],
  }),
  journalHeader: one(journalHeaders, {
    fields: [bills.journalHeaderId],
    references: [journalHeaders.id],
  }),
}));

export const authAccountsRelations = relations(authAccounts, ({ one }) => ({
  authUser: one(authUsers, {
    fields: [authAccounts.userId],
    references: [authUsers.id],
  }),
}));

export const authUsersRelations = relations(authUsers, ({ many }) => ({
  authAccounts: many(authAccounts),
  authMembers: many(authMembers),
  authInvitations: many(authInvitations),
  authSessions: many(authSessions),
}));

export const authMembersRelations = relations(authMembers, ({ one }) => ({
  authUser: one(authUsers, {
    fields: [authMembers.userId],
    references: [authUsers.id],
  }),
  authOrganization: one(authOrganizations, {
    fields: [authMembers.organizationId],
    references: [authOrganizations.id],
  }),
}));

export const authOrganizationsRelations = relations(authOrganizations, ({ many }) => ({
  authMembers: many(authMembers),
  authInvitations: many(authInvitations),
}));

export const authInvitationsRelations = relations(authInvitations, ({ one }) => ({
  authOrganization: one(authOrganizations, {
    fields: [authInvitations.organizationId],
    references: [authOrganizations.id],
  }),
  authUser: one(authUsers, {
    fields: [authInvitations.inviterId],
    references: [authUsers.id],
  }),
}));

export const journalHeadersRelations = relations(journalHeaders, ({ one, many }) => ({
  party: one(parties, {
    fields: [journalHeaders.partyId],
    references: [parties.id],
  }),
  bills: many(bills),
  invoices: many(invoices),
  journalLines: many(journalLines),
  documentSuggestions: many(documentSuggestions),
}));

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  authUser: one(authUsers, {
    fields: [authSessions.userId],
    references: [authUsers.id],
  }),
}));

export const journalLinesRelations = relations(journalLines, ({ one, many }) => ({
  journalHeader: one(journalHeaders, {
    fields: [journalLines.journalHeaderId],
    references: [journalHeaders.id],
  }),
  account: one(accounts, {
    fields: [journalLines.accountId],
    references: [accounts.id],
  }),
  dimension_departmentId: one(dimensions, {
    fields: [journalLines.departmentId],
    references: [dimensions.id],
    relationName: "journalLines_departmentId_dimensions_id",
  }),
  dimension_locationId: one(dimensions, {
    fields: [journalLines.locationId],
    references: [dimensions.id],
    relationName: "journalLines_locationId_dimensions_id",
  }),
  statementLines: many(statementLines),
}));

export const statementLinesRelations = relations(statementLines, ({ one, many }) => ({
  reconciliation: one(reconciliations, {
    fields: [statementLines.reconciliationId],
    references: [reconciliations.id],
  }),
  journalLine: one(journalLines, {
    fields: [statementLines.matchedJournalLineId],
    references: [journalLines.id],
  }),
  reconciliationFlags: many(reconciliationFlags),
}));

export const reconciliationFlagsRelations = relations(reconciliationFlags, ({ one }) => ({
  reconciliation: one(reconciliations, {
    fields: [reconciliationFlags.reconciliationId],
    references: [reconciliations.id],
  }),
  statementLine: one(statementLines, {
    fields: [reconciliationFlags.statementLineId],
    references: [statementLines.id],
  }),
}));

export const documentSuggestionsRelations = relations(documentSuggestions, ({ one }) => ({
  document: one(documents, {
    fields: [documentSuggestions.documentId],
    references: [documents.id],
  }),
  journalHeader: one(journalHeaders, {
    fields: [documentSuggestions.suggestedJournalHeaderId],
    references: [journalHeaders.id],
  }),
}));
