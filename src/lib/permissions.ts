import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  adminAc,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

/**
 * ABAC Permission System
 *
 * Defines resources and actions for the accounting system.
 * Inspired by: https://github.com/WebDevSimplified/permission-system/blob/main/auth-abac.ts
 */

// Resource/action statements for the accounting system
export const statement = {
  // Include Better Auth's default organization statements
  ...defaultStatements,
  // Accounting resources
  account: ["view", "create", "update", "delete"],
  journal: ["view", "create", "update", "delete", "post", "void", "match", "unmatch"],
  reconciliation: ["view", "create", "finalize"],
  invoice: ["view", "create", "update", "delete", "send"],
  bill: ["view", "create", "update", "delete", "pay"],
  document: ["view", "upload", "delete"],
  party: ["view", "create", "update", "delete"],
  dimension: ["view", "create", "update", "delete"],
  connection: ["view", "create", "update", "delete"],
  financialAccount: ["view", "create", "update", "delete"],
  report: ["view", "export"],
  comment: ["create", "edit", "delete", "moderate"],
  inbox: ["view", "create", "update", "assign", "approve", "reject", "override"],
  review: ["view", "resolve", "run"],
  agentRule: ["view", "configure", "run"],
  // AI task surface (endpoints + proposals). Deliberately distinct from
  // agentRule (which gates the deterministic review-agents feature) so the two
  // grants stay independently assignable. Two-key model: every AI endpoint
  // gates aiTask:<action> PLUS its underlying resource, and proposal appliers
  // re-check the underlying create/update permission — aiTask:run alone never
  // launders a write.
  aiTask: ["view", "run", "configure"],
  integration: ["view", "authorize", "sync", "disconnect"],
  firm: ["view", "manage", "assignClients"],
} as const;

// Create the access controller
export const ac = createAccessControl(statement);

/**
 * Superuser role - Full access to everything
 */
export const superuser = ac.newRole({
  ...ownerAc.statements,
  account: ["view", "create", "update", "delete"],
  journal: ["view", "create", "update", "delete", "post", "void", "match", "unmatch"],
  reconciliation: ["view", "create", "finalize"],
  invoice: ["view", "create", "update", "delete", "send"],
  bill: ["view", "create", "update", "delete", "pay"],
  document: ["view", "upload", "delete"],
  party: ["view", "create", "update", "delete"],
  dimension: ["view", "create", "update", "delete"],
  connection: ["view", "create", "update", "delete"],
  financialAccount: ["view", "create", "update", "delete"],
  report: ["view", "export"],
  comment: ["create", "edit", "delete", "moderate"],
  inbox: ["view", "create", "update", "assign", "approve", "reject", "override"],
  review: ["view", "resolve", "run"],
  agentRule: ["view", "configure", "run"],
  aiTask: ["view", "run", "configure"],
  integration: ["view", "authorize", "sync", "disconnect"],
  firm: ["view", "manage", "assignClients"],
});

/**
 * Admin role - Full access except organization deletion
 */
export const admin = ac.newRole({
  ...adminAc.statements,
  account: ["view", "create", "update", "delete"],
  journal: ["view", "create", "update", "delete", "post", "void", "match", "unmatch"],
  reconciliation: ["view", "create", "finalize"],
  invoice: ["view", "create", "update", "delete", "send"],
  bill: ["view", "create", "update", "delete", "pay"],
  document: ["view", "upload", "delete"],
  party: ["view", "create", "update", "delete"],
  dimension: ["view", "create", "update", "delete"],
  connection: ["view", "create", "update", "delete"],
  financialAccount: ["view", "create", "update", "delete"],
  report: ["view", "export"],
  comment: ["create", "edit", "delete", "moderate"],
  inbox: ["view", "create", "update", "assign", "approve", "reject", "override"],
  review: ["view", "resolve", "run"],
  agentRule: ["view", "configure", "run"],
  aiTask: ["view", "run", "configure"],
  integration: ["view", "authorize", "sync", "disconnect"],
  firm: ["view", "manage", "assignClients"],
});

/**
 * Member role - View access plus limited create/update
 */
export const member = ac.newRole({
  ...memberAc.statements,
  account: ["view"],
  journal: ["view", "create", "update"],
  reconciliation: ["view"],
  invoice: ["view", "create", "update"],
  bill: ["view", "create", "update"],
  document: ["view", "upload"],
  party: ["view"],
  dimension: ["view"],
  connection: ["view"],
  financialAccount: ["view"],
  report: ["view"],
  comment: ["create", "edit", "delete"],
  inbox: ["view", "create", "update"],
  review: ["view"],
  agentRule: ["view"],
  // aiTask:run lets members use AI tasks; what a task may WRITE is still
  // bounded by their underlying resource permissions (two-key model).
  aiTask: ["view", "run"],
  integration: ["view"],
  firm: ["view"],
});

/**
 * Client approver - Can review and approve work prepared by a firm, but cannot
 * configure the ledger, integrations, or agent rules.
 */
export const clientApprover = ac.newRole({
  ...memberAc.statements,
  account: ["view"],
  journal: ["view"],
  reconciliation: ["view"],
  invoice: ["view"],
  bill: ["view"],
  document: ["view"],
  party: ["view"],
  dimension: ["view"],
  connection: ["view"],
  financialAccount: ["view"],
  report: ["view"],
  comment: ["create", "edit", "delete"],
  inbox: ["view", "update", "approve", "reject"],
  review: ["view", "resolve"],
  agentRule: ["view"],
  // Fixes the ai_findings #16 under-grant: read-only AI tasks (e.g. the smart
  // date filter) need only aiTask:run, which this all-view role now holds.
  aiTask: ["view", "run"],
  integration: ["view"],
  firm: ["view"],
});

/**
 * Report viewer - Read-only access for holding-company analysts and executives.
 *
 * This role can inspect source transactions and export financial reports, but
 * it cannot create, update, approve, post, configure, or run AI operations.
 * Business Group access remains a separate grant: a user must hold both this
 * direct organization membership and a group membership before that entity's
 * figures are included in a group view.
 */
export const reportViewer = ac.newRole({
  ...memberAc.statements,
  account: ["view"],
  journal: ["view"],
  reconciliation: ["view"],
  invoice: ["view"],
  bill: ["view"],
  document: ["view"],
  party: ["view"],
  dimension: ["view"],
  connection: ["view"],
  financialAccount: ["view"],
  report: ["view", "export"],
  comment: [],
  inbox: ["view"],
  review: ["view"],
  agentRule: ["view"],
  aiTask: ["view"],
  integration: ["view"],
  firm: ["view"],
});

// Export role map for use in auth configuration
export const roles = {
  superuser,
  admin,
  member,
  clientApprover,
  reportViewer,
  // Aliases for Better Auth compatibility
  owner: superuser,
};

// Type exports for permission checking
export type Resource = keyof typeof statement;
export type Action<R extends Resource> = (typeof statement)[R][number];
