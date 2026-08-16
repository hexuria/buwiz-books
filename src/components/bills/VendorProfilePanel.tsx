/**
 * Vendor Profile Panel — replaces the right-hand column
 * when "Complete Vendor Profile" is clicked.
 *
 * Sections: Contact Info → Payment Destination (Bank Transfer / Check) → Footer
 */
import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateParty } from "../../routes/api/-parties";

// ============================================================================
// Types
// ============================================================================

interface VendorProfilePanelProps {
  vendorId: string;
  vendorName: string | null;
  vendorEmail: string | null;
  vendorBankRouting: string | null;
  vendorBankAccount: string | null;
  vendorMailingAddress: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  } | null;
  /** AI-suggested mailing address from the bill OCR */
  aiSuggestedAddress?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  } | null;
  billId: string;
  onClose: () => void;
}

type PaymentMethod = "bank_transfer" | "check";

// ============================================================================
// Component
// ============================================================================

export function VendorProfilePanel({
  vendorId,
  vendorName,
  vendorEmail,
  vendorBankRouting,
  vendorBankAccount,
  vendorMailingAddress,
  aiSuggestedAddress,
  billId,
  onClose,
}: VendorProfilePanelProps) {
  const queryClient = useQueryClient();

  // Contact Info
  const [name, setName] = useState(vendorName ?? "");
  const [email, setEmail] = useState(vendorEmail ?? "");

  // Payment destination
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    vendorBankRouting || vendorBankAccount ? "bank_transfer" : "check",
  );
  const [routingNumber, setRoutingNumber] = useState(vendorBankRouting ?? "");
  const [accountNumber, setAccountNumber] = useState(vendorBankAccount ?? "");

  // Mailing address
  const [payTo, setPayTo] = useState(vendorName ?? "");
  const [addressLine1, setAddressLine1] = useState(vendorMailingAddress?.street ?? "");
  const [city, setCity] = useState(vendorMailingAddress?.city ?? "");
  const [addrState, setAddrState] = useState(vendorMailingAddress?.state ?? "");
  const [zip, setZip] = useState(vendorMailingAddress?.postalCode ?? "");
  const [country, setCountry] = useState(vendorMailingAddress?.country ?? "");

  // Sync if props change
  useEffect(() => {
    setName(vendorName ?? "");
    setEmail(vendorEmail ?? "");
    setRoutingNumber(vendorBankRouting ?? "");
    setAccountNumber(vendorBankAccount ?? "");
    setPayTo(vendorName ?? "");
    setAddressLine1(vendorMailingAddress?.street ?? "");
    setCity(vendorMailingAddress?.city ?? "");
    setAddrState(vendorMailingAddress?.state ?? "");
    setZip(vendorMailingAddress?.postalCode ?? "");
    setCountry(vendorMailingAddress?.country ?? "");
  }, [vendorName, vendorEmail, vendorBankRouting, vendorBankAccount, vendorMailingAddress]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const data: Record<string, unknown> = {
        id: vendorId,
        name: name.trim() || undefined,
        email: email.trim() || undefined,
      };

      if (paymentMethod === "bank_transfer") {
        data.bankRoutingNumber = routingNumber.trim() || undefined;
        data.bankAccountNumber = accountNumber.trim() || undefined;
      } else {
        data.mailingAddress = {
          street: addressLine1.trim() || undefined,
          city: city.trim() || undefined,
          state: addrState.trim() || undefined,
          postalCode: zip.trim() || undefined,
          country: country.trim() || undefined,
        };
      }

      return (updateParty as (opts: { data: unknown }) => Promise<unknown>)({ data });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bill", billId] });
      onClose();
    },
  });

  const prefillFromAI = () => {
    if (!aiSuggestedAddress) return;
    setPayTo(vendorName ?? "");
    setAddressLine1(aiSuggestedAddress.street ?? "");
    setCity(aiSuggestedAddress.city ?? "");
    setAddrState(aiSuggestedAddress.state ?? "");
    setZip(aiSuggestedAddress.postalCode ?? "");
    setCountry(aiSuggestedAddress.country ?? "");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-lg text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white">Vendor Profile</h3>
        </div>

        {/* ─── Contact Info ─── */}
        <section>
          <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
            Contact Info
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                Vendor Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                placeholder="Vendor name"
              />
            </div>
            <div>
              <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                Vendor Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                placeholder="vendor@example.com"
              />
            </div>
          </div>
        </section>

        {/* ─── Payment Destination ─── */}
        <section>
          <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
            Payment Destination
          </div>

          {/* Method selector */}
          <div className="flex gap-2 mb-4">
            <button
              type="button"
              onClick={() => setPaymentMethod("bank_transfer")}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-all border ${
                paymentMethod === "bank_transfer"
                  ? "border-[#10b981] bg-[#10b981]/10 text-[#10b981] dark:bg-[#10b981]/20"
                  : "border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 hover:border-[#cbd5e1] dark:hover:border-white/20"
              }`}
            >
              <span className="flex items-center justify-center gap-1.5">
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
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
                Bank Transfer
              </span>
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod("check")}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-all border ${
                paymentMethod === "check"
                  ? "border-[#10b981] bg-[#10b981]/10 text-[#10b981] dark:bg-[#10b981]/20"
                  : "border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 hover:border-[#cbd5e1] dark:hover:border-white/20"
              }`}
            >
              <span className="flex items-center justify-center gap-1.5">
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
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                Check
              </span>
            </button>
          </div>

          {/* Bank Transfer fields */}
          {paymentMethod === "bank_transfer" && (
            <div className="p-4 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]/50">
              <div className="text-xs font-medium text-[#1e293b] dark:text-white mb-3">
                New Bank Account (ACH)
              </div>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                    Routing No.
                  </label>
                  <input
                    type="text"
                    value={routingNumber}
                    onChange={(e) => setRoutingNumber(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all font-mono"
                    placeholder="000000000"
                    maxLength={9}
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                    Account Number
                  </label>
                  <input
                    type="text"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all font-mono"
                    placeholder="0000000000"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Check fields */}
          {paymentMethod === "check" && (
            <div className="flex flex-col gap-4">
              {/* AI Suggested */}
              {aiSuggestedAddress && (aiSuggestedAddress.street || aiSuggestedAddress.city) && (
                <div className="p-4 rounded-lg border border-[#a7f3d0] dark:border-emerald-800/40 bg-[#ecfdf5] dark:bg-emerald-900/20">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="2"
                      >
                        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20z" />
                        <path d="M12 16v-4M12 8h.01" />
                      </svg>
                      <span className="text-xs font-medium text-[#065f46] dark:text-emerald-300">
                        AI Suggested Mailing Address
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={prefillFromAI}
                      className="text-[11px] font-medium text-[#10b981] hover:text-[#059669] transition-colors px-2 py-1 rounded hover:bg-[#10b981]/10"
                    >
                      Select
                    </button>
                  </div>
                  <div className="text-xs text-[#047857] dark:text-emerald-400/80 leading-relaxed">
                    {aiSuggestedAddress.street && <div>{aiSuggestedAddress.street}</div>}
                    <div>
                      {[
                        aiSuggestedAddress.city,
                        aiSuggestedAddress.state,
                        aiSuggestedAddress.postalCode,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </div>
                    {aiSuggestedAddress.country && <div>{aiSuggestedAddress.country}</div>}
                  </div>
                </div>
              )}

              {/* Manual mailing address */}
              <div className="p-4 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]/50">
                <div className="text-xs font-medium text-[#1e293b] dark:text-white mb-3">
                  Add Vendor Mailing Address
                </div>
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                      Pay To
                    </label>
                    <input
                      type="text"
                      value={payTo}
                      onChange={(e) => setPayTo(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                      placeholder="Vendor name"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                      Address
                    </label>
                    <input
                      type="text"
                      value={addressLine1}
                      onChange={(e) => setAddressLine1(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                      placeholder="Address line"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                        placeholder="City"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                        State
                      </label>
                      <input
                        type="text"
                        value={addrState}
                        onChange={(e) => setAddrState(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                        placeholder="State"
                        maxLength={2}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                        Zip
                      </label>
                      <input
                        type="text"
                        value={zip}
                        onChange={(e) => setZip(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                        placeholder="00000"
                        maxLength={10}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[#64748b] dark:text-white/50 mb-1">
                      Country
                    </label>
                    <input
                      type="text"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                      placeholder="US"
                      maxLength={2}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ─── Footer ─── */}
      <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827]">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="px-4 py-2 rounded-lg bg-[#10b981] hover:bg-[#059669] text-white text-sm font-medium transition-all disabled:opacity-50"
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
