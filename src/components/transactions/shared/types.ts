/**
 * Shared types for transaction forms (New + Detail pages)
 */
import type { createParty, listParties } from "../../../routes/api/-parties";

export type TabType = "journal" | "pay_in" | "pay_out" | "transfer";

export interface AccountOption {
  id: string;
  name: string;
  accountNumber?: string | null;
  accountType: string;
  subtype?: string | null;
  icon?: string | null;
  parentId?: string | null;
  readPartyTypes?: string[] | null;
  mutatePartyTypes?: string[] | null;
}

export type ListPartiesFn = typeof listParties;
export type CreatePartyFn = typeof createParty;
export type PartyListItem = Awaited<ReturnType<ListPartiesFn>>[number];

export interface JournalLine {
  key: string;
  description: string;
  categoryId: string;
  partyId: string;
  departmentId: string;
  locationId: string;
  debit: string;
  credit: string;
}

export interface PayForLine {
  key: string;
  description: string;
  categoryId: string;
  departmentId: string;
  locationId: string;
  amount: string;
}
