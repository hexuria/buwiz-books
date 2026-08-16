/**
 * Discount Modal — shared between invoice create/edit
 */
import { useState, useEffect } from "react";
import { Modal } from "../ui/Modal";

export interface DiscountModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string, type: "amount" | "percent", value: string) => void;
  initialName?: string;
  initialType?: "amount" | "percent";
  initialValue?: string;
}

export function DiscountModal({
  open,
  onClose,
  onSave,
  initialName = "",
  initialType = "percent",
  initialValue = "",
}: DiscountModalProps) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<"amount" | "percent">(initialType);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setType(initialType);
      setValue(initialValue);
    }
  }, [open, initialName, initialType, initialValue]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Discount"
      mobile="fullscreen"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-11 px-4 text-sm font-medium text-[#64748b] dark:text-white/60 hover:text-[#1e293b] dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(name, type, value);
              onClose();
            }}
            className="h-11 px-5 rounded-lg text-sm font-semibold text-white bg-[#22c55e] hover:bg-[#16a34a] shadow-md transition-all"
          >
            Save
          </button>
        </>
      }
    >
      <div className="p-4 rounded-lg bg-[#f0f9ff] dark:bg-[#0f172a] border border-[#e0f2fe] dark:border-white/10">
        <div className="flex flex-col gap-4 sm:flex-row">
          {/* Name */}
          <div className="flex-1">
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
              Discount Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Annual Discount"
              autoFocus
              className="w-full h-11 px-3 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all"
            />
          </div>
          {/* Amount */}
          <div className="sm:w-44">
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
              Amount <span className="text-[#94a3b8]">(Optional)</span>
            </label>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center rounded-md border border-[#e2e8f0] dark:border-white/10 overflow-hidden shrink-0">
                <button
                  type="button"
                  onClick={() => setType("percent")}
                  className={`h-11 w-11 text-sm font-bold transition-colors ${
                    type === "percent"
                      ? "bg-[#6366f1] text-white"
                      : "text-[#94a3b8] hover:bg-[#f1f5f9] dark:hover:bg-white/5 bg-white dark:bg-[#0f172a]"
                  }`}
                >
                  %
                </button>
                <button
                  type="button"
                  onClick={() => setType("amount")}
                  className={`h-11 w-11 text-sm font-bold transition-colors ${
                    type === "amount"
                      ? "bg-[#6366f1] text-white"
                      : "text-[#94a3b8] hover:bg-[#f1f5f9] dark:hover:bg-white/5 bg-white dark:bg-[#0f172a]"
                  }`}
                >
                  $
                </button>
              </div>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={type === "percent" ? "0%" : "0.00"}
                className="w-full h-11 px-3 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white text-right placeholder-[#cbd5e1] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all"
              />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
