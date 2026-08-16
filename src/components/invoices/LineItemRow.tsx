/**
 * Line Item Row — shared between invoice create/edit views
 */
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAccounts } from "@/routes/api/-accounts";
import type { LineItem } from "./invoice-shared";
import { formatCurrency } from "./invoice-shared";
import { ProductCombobox } from "./ProductCombobox";

export function LineItemRow({
  item,
  index,
  lineItems,
  setLineItems,
  updateLineItem,
  removeLineItem,
  toggleNote,
  onOpenDiscount,
}: {
  item: LineItem;
  index: number;
  lineItems: LineItem[];
  setLineItems: React.Dispatch<React.SetStateAction<LineItem[]>>;
  updateLineItem: (id: string, field: keyof LineItem, value: string) => void;
  removeLineItem: (id: string) => void;
  toggleNote: (id: string) => void;
  onOpenDiscount: (itemId: string) => void;
}) {
  const qtyRef = useRef<HTMLInputElement>(null);
  const { data: revenueAccounts = [] } = useQuery({
    queryKey: ["invoice-revenue-accounts"],
    queryFn: () =>
      listAccounts({
        data: {
          includeChildren: false,
          status: ["active"],
          types: ["revenue", "other_income"],
        },
      }),
  });

  // Determine which rows are present for rounding logic
  const hasNote = !!item.showNote;
  const hasDiscount = !!item.discountValue;
  const isMainLast = !hasNote && !hasDiscount;
  const isNoteLast = hasNote && !hasDiscount;

  const cardBg = "bg-[#F5F6F9] dark:bg-[#0d1b2f]";

  return (
    <tbody
      className="group/linegroup"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        (e.currentTarget as HTMLElement).style.opacity = "0.4";
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).style.opacity = "1";
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const fromIndex = Number(e.dataTransfer.getData("text/plain"));
        const toIndex = index;
        if (fromIndex !== toIndex) {
          setLineItems((prev) => {
            const next = [...prev];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return next;
          });
        }
      }}
    >
      {/* Spacer between line item cards */}
      {index > 0 && (
        <tr>
          <td colSpan={7} className="h-2" />
        </tr>
      )}
      {/* Main row */}
      <tr className="group/row">
        {/* Line number / drag handle */}
        <td
          className={`py-2 w-8 align-top ${cardBg} rounded-tl-xl ${isMainLast ? "rounded-bl-xl" : ""}`}
        >
          <div className="flex items-center justify-center h-9">
            <span className="text-xs text-[#94a3b8] dark:text-white/30 font-medium group-hover/row:hidden select-none">
              {index + 1}
            </span>
            <span className="hidden group-hover/row:flex items-center text-[#94a3b8] dark:text-white/30 cursor-grab active:cursor-grabbing">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="9" cy="5" r="1.5" />
                <circle cx="15" cy="5" r="1.5" />
                <circle cx="9" cy="12" r="1.5" />
                <circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="19" r="1.5" />
                <circle cx="15" cy="19" r="1.5" />
              </svg>
            </span>
          </div>
        </td>
        {/* Item / Product */}
        <td className={`py-2 pr-3 ${cardBg}`}>
          <ProductCombobox
            value={item.description}
            onChange={(text) => {
              setLineItems((prev) =>
                prev.map((li) => (li.id === item.id ? { ...li, description: text } : li)),
              );
            }}
            onSelect={(name, price) => {
              setLineItems((prev) =>
                prev.map((li) => {
                  if (li.id !== item.id) return li;
                  const updated = { ...li, description: name };
                  if (price && Number(price) > 0) {
                    updated.unitPrice = price;
                    const qty = Number.parseFloat(updated.quantity) || 0;
                    updated.amount = (qty * Number(price)).toFixed(2);
                  }
                  return updated;
                }),
              );
              setTimeout(() => qtyRef.current?.focus(), 0);
            }}
          />
          <select
            aria-label={`Revenue account for line ${index + 1}`}
            value={item.revenueAccountId ?? ""}
            onChange={(e) => updateLineItem(item.id, "revenueAccountId", e.target.value)}
            className="mt-1.5 w-full px-2.5 py-1.5 rounded-md border border-[#d6e4f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-xs text-[#475569] dark:text-white/70 focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all"
          >
            <option value="">Select revenue account</option>
            {revenueAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.accountNumber ? `${account.accountNumber} · ` : ""}
                {account.name}
              </option>
            ))}
          </select>
        </td>

        {/* Hover action icons */}
        <td className={`py-2 align-top ${cardBg}`}>
          <div className="flex items-center gap-0.5 transition-opacity opacity-0 group-hover/linegroup:opacity-100">
            {!item.showNote && (
              <button
                type="button"
                onClick={() => toggleNote(item.id)}
                className="p-1.5 rounded transition-colors text-[#94a3b8] dark:text-white/30 hover:text-[#6366f1] hover:bg-[#eef2ff] dark:hover:bg-indigo-900/20"
                title="Add description"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 10.5V6.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C17.72 2 16.88 2 15.2 2H8.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C4 4.28 4 5.12 4 6.8v10.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C6.28 22 7.12 22 8.8 22H12m2-11H8m2 4H8m8-8H8m10 14v-6m-3 3h6" />
                </svg>
              </button>
            )}
            {!item.discountValue && (
              <button
                type="button"
                onClick={() => onOpenDiscount(item.id)}
                className="p-1.5 rounded transition-colors text-[#94a3b8] dark:text-white/30 hover:text-[#6366f1] hover:bg-[#eef2ff] dark:hover:bg-indigo-900/20"
                title="Add discount"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="19" y1="5" x2="5" y2="19" />
                  <circle cx="6.5" cy="6.5" r="2.5" />
                  <circle cx="17.5" cy="17.5" r="2.5" />
                </svg>
              </button>
            )}
          </div>
        </td>

        {/* Qty */}
        <td className={`py-2 pr-3 align-top ${cardBg}`}>
          <input
            ref={qtyRef}
            type="number"
            min="0"
            step="1"
            value={item.quantity}
            onChange={(e) => updateLineItem(item.id, "quantity", e.target.value)}
            className="w-full px-2.5 py-2 rounded-md border border-[#d6e4f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white text-center focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all"
          />
        </td>

        {/* Price */}
        <td className={`py-2 pr-3 align-top ${cardBg}`}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={item.unitPrice}
            onChange={(e) => updateLineItem(item.id, "unitPrice", e.target.value)}
            placeholder="0.00"
            className="w-full px-2.5 py-2 rounded-md border border-[#d6e4f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white text-right placeholder-[#cbd5e1] dark:placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all"
          />
        </td>

        {/* Total */}
        <td className={`py-2 text-right align-top ${cardBg}`}>
          <div className="h-9 flex items-center justify-end">
            <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
              {formatCurrency(Number.parseFloat(item.amount) || 0)}
            </span>
          </div>
        </td>

        {/* Delete button */}
        <td
          className={`py-2 pl-1 align-top w-9 ${cardBg} rounded-tr-xl ${isMainLast ? "rounded-br-xl" : ""}`}
        >
          {lineItems.length > 1 && (
            <button
              type="button"
              onClick={() => removeLineItem(item.id)}
              className="flex items-center justify-center w-7 h-9 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-md opacity-0 group-hover/linegroup:opacity-100 transition-opacity text-[#94a3b8] dark:text-white/30 hover:text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20"
              title="Delete line item"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </td>
      </tr>

      {/* Note row */}
      {item.showNote && (
        <tr>
          <td className={`pb-2 align-top ${cardBg} ${isNoteLast ? "rounded-bl-xl" : ""}`}>
            <div className="flex items-center justify-center h-9">
              <button
                type="button"
                onClick={() => toggleNote(item.id)}
                className="p-1 rounded-full text-[#94a3b8] dark:text-white/30 hover:text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-all opacity-0 group-hover/linegroup:opacity-100"
                title="Remove description"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m15 9-6 6M9 9l6 6" />
                </svg>
              </button>
            </div>
          </td>
          <td colSpan={4} className={`pb-2 pr-3 ${cardBg}`}>
            <textarea
              value={item.note}
              onChange={(e) => {
                updateLineItem(item.id, "note", e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              rows={1}
              placeholder="Add a description or note"
              className="w-full px-2.5 py-2 rounded-md border border-[#d6e4f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#475569] dark:text-white/70 placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all resize-none overflow-hidden"
            />
          </td>
          <td className={cardBg} />
          <td className={`${cardBg} ${isNoteLast ? "rounded-br-xl" : ""}`} />
        </tr>
      )}

      {/* Per-line discount row */}
      {item.discountValue && (
        <tr>
          <td className={`pb-2 align-top ${cardBg} rounded-bl-xl`}>
            <div className="flex items-center justify-center h-9">
              <button
                type="button"
                onClick={() => {
                  updateLineItem(item.id, "discountName", "");
                  updateLineItem(item.id, "discountValue", "");
                }}
                className="p-1 rounded-full text-[#94a3b8] dark:text-white/30 hover:text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-all opacity-0 group-hover/linegroup:opacity-100"
                title="Remove discount"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m15 9-6 6M9 9l6 6" />
                </svg>
              </button>
            </div>
          </td>
          {/* Tag icon + discount name */}
          <td colSpan={2} className={`pb-2 pr-3 ${cardBg}`}>
            <div className="flex items-center gap-1">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                className="text-[#6366f1] shrink-0"
              >
                <path
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M16.257 11h-.01m6.01-2.8v4.475c0 .489 0 .733-.055.963-.049.204-.13.4-.24.579-.123.201-.296.374-.642.72l-7.669 7.669c-1.188 1.188-1.782 1.782-2.467 2.004a3 3 0 0 1-1.854 0c-.685-.222-1.279-.816-2.467-2.004l-2.212-2.212c-1.188-1.188-1.782-1.782-2.004-2.467a3 3 0 0 1 0-1.854c.222-.685.816-1.28 2.004-2.467l7.67-7.669c.345-.346.518-.519.72-.642q.27-.165.578-.24c.23-.055.475-.055.964-.055h4.474c1.12 0 1.68 0 2.108.218a2 2 0 0 1 .874.874c.218.428.218.988.218 2.108m-6.5 2.8a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0"
                />
              </svg>
              <span className="text-xs text-[#6366f1] font-medium">
                {item.discountName || "Discount"}
              </span>
            </div>
          </td>
          {/* Skip Qty */}
          <td className={cardBg} />
          {/* Editable discount value */}
          <td className={`pb-2 pr-3 ${cardBg}`}>
            <div className="relative">
              {item.discountType !== "percent" && (
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-[#94a3b8] dark:text-white/30 pointer-events-none">
                  $
                </span>
              )}
              <input
                type="text"
                value={
                  item.discountType === "percent"
                    ? `${item.discountValue}%`
                    : (Number(item.discountValue) || 0).toFixed(2)
                }
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9.]/g, "");
                  updateLineItem(item.id, "discountValue", raw);
                }}
                className={`w-full py-1.5 rounded-md border border-[#d6e4f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white text-right focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all ${
                  item.discountType !== "percent" ? "pl-6 pr-2.5" : "px-2.5"
                }`}
              />
            </div>
          </td>
          {/* Subtracted amount */}
          <td className={`pb-2 text-right ${cardBg}`}>
            <span className="text-sm font-medium text-[#ef4444]">
              -
              {formatCurrency(
                item.discountType === "percent"
                  ? ((Number.parseFloat(item.quantity) || 0) *
                      (Number.parseFloat(item.unitPrice) || 0) *
                      (Number.parseFloat(item.discountValue) || 0)) /
                      100
                  : Number.parseFloat(item.discountValue) || 0,
              )}
            </span>
          </td>
          <td className={`${cardBg} rounded-br-xl`} />
        </tr>
      )}
    </tbody>
  );
}
