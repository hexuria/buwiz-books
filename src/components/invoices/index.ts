/**
 * Invoice Components — barrel export
 */
export { DiscountModal } from "./DiscountModal";
export type { DiscountModalProps } from "./DiscountModal";
export { CustomerCombobox } from "./CustomerCombobox";
export { ProductCombobox } from "./ProductCombobox";
export { LineItemRow } from "./LineItemRow";
export {
  generateId,
  formatCurrency,
  todayISO,
  addDays,
  createEmptyLineItem,
} from "./invoice-shared";
export type { LineItem } from "./invoice-shared";
export { MarkAsPaidModal } from "./MarkAsPaidModal";
export type { MarkAsPaidModalProps } from "./MarkAsPaidModal";
