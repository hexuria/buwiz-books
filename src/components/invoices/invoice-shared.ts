/**
 * Shared Invoice Types & Helpers
 */

export interface LineItem {
  id: string;
  description: string;
  note: string;
  showNote: boolean;
  quantity: string;
  unitPrice: string;
  amount: string;
  productId?: string;
  revenueAccountId?: string;
  discountName: string;
  discountType: "amount" | "percent";
  discountValue: string;
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export { formatCurrency } from "@/utils/format";

export function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export function createEmptyLineItem(): LineItem {
  return {
    id: generateId(),
    description: "",
    note: "",
    showNote: false,
    quantity: "1",
    unitPrice: "",
    amount: "0",
    revenueAccountId: "",
    discountName: "",
    discountType: "percent",
    discountValue: "",
  };
}
