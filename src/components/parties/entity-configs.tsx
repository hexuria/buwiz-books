/**
 * Per-entity configuration for the shared EntityListPage. The six entities.* list routes
 * (customers, vendors, employees, government, lenders, shareholders) were near-identical
 * copies; they now all render <EntityListPage config={...} /> with one of these configs.
 */
import type { ReactNode } from "react";
import type { PartyTypeValue } from "./PartyCreateForm";

export interface EntityConfig {
  /** Party type passed to listParties / PartyCreateForm. */
  partyType: PartyTypeValue;
  /** Plural, title-case label, e.g. "Customers". */
  titlePlural: string;
  /** Singular, title-case label, e.g. "Customer". */
  titleSingular: string;
  /**
   * Primary "create" button label. The originals were NOT uniform ("New Customer" but
   * "Add Employee", "New Agency"), so this is explicit per entity.
   */
  newLabel: string;
  /** Lowercase plural noun for empty-state copy (defaults to titlePlural lowercased). */
  emptyPlural?: string;
  /** Full "add your first…" CTA text (defaults to `Add your first {singular}`). */
  addFirstLabel?: string;
  /** Optional listParties limit (employees historically fetched 200). */
  queryLimit?: number;
  /** Inner SVG elements for this entity's icon (paths/circles/etc), rendered at several sizes. */
  iconPaths: ReactNode;
}

export const ENTITY_CONFIGS: Record<string, EntityConfig> = {
  customer: {
    partyType: "customer",
    titlePlural: "Customers",
    titleSingular: "Customer",
    newLabel: "New Customer",
    iconPaths: (
      <>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </>
    ),
  },
  vendor: {
    partyType: "vendor",
    titlePlural: "Vendors",
    titleSingular: "Vendor",
    newLabel: "New Vendor",
    iconPaths: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
  employee: {
    partyType: "employee",
    titlePlural: "Employees",
    titleSingular: "Employee",
    newLabel: "Add Employee",
    addFirstLabel: "Add your first employee to get started",
    queryLimit: 200,
    iconPaths: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </>
    ),
  },
  government: {
    partyType: "government",
    titlePlural: "Government",
    titleSingular: "Government Agency",
    newLabel: "New Agency",
    emptyPlural: "agencies",
    addFirstLabel: "Add your first agency",
    iconPaths: (
      <>
        <path d="M3 21h18" />
        <path d="M5 21V7l7-4 7 4v14" />
        <path d="M9 21v-4h6v4" />
        <path d="M9 10h1" />
        <path d="M14 10h1" />
        <path d="M9 14h1" />
        <path d="M14 14h1" />
      </>
    ),
  },
  lender: {
    partyType: "lender",
    titlePlural: "Lenders",
    titleSingular: "Lender",
    newLabel: "New Lender",
    iconPaths: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </>
    ),
  },
  shareholder: {
    partyType: "shareholder",
    titlePlural: "Shareholders",
    titleSingular: "Shareholder",
    newLabel: "New Shareholder",
    iconPaths: (
      <>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </>
    ),
  },
};
