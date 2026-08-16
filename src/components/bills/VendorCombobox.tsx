/**
 * Vendor Combobox + New Vendor Modal — shared between bill create/edit
 * Mirrors CustomerCombobox pattern for consistency.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listParties, createParty } from "@/routes/api/-parties";

// ============================================================================
// New Vendor Modal
// ============================================================================

function NewVendorModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (vendor: any) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [street, setStreet] = useState("");
  const [street2, setStreet2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (data: any) =>
      (createParty as (opts: { data: unknown }) => Promise<any>)({
        data,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["parties"] });
      onCreated(created);
    },
  });

  const handleSave = () => {
    if (!name.trim()) return;
    mutation.mutate({
      name: name.trim(),
      partyType: "vendor",
      email: email || undefined,
      phone: phone || undefined,
      address:
        street || city || state || zip
          ? {
              street: [street, street2].filter(Boolean).join(", ") || undefined,
              city: city || undefined,
              state: state || undefined,
              postalCode: zip || undefined,
            }
          : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        role="button"
        tabIndex={0}
        aria-label="Close modal"
      />

      {/* Modal */}
      <div className="relative w-full max-w-[512px] mx-4 rounded-xl shadow-2xl overflow-hidden transition-all">
        {/* Header */}
        <div className="bg-gradient-to-r from-[#f59e0b] to-[#d97706] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <h2 className="text-lg font-semibold text-white">New Vendor</h2>
          </div>
        </div>

        {/* Body */}
        <div className="bg-white dark:bg-[#1e293b] px-6 py-5 space-y-5">
          {/* Contact Info */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#64748b"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                Contact Info
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                  Company / Vendor Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                  Phone
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                />
              </div>
            </div>
          </div>

          {/* Address */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#64748b"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span className="text-sm font-semibold text-[#1e293b] dark:text-white">
                Mailing Address
              </span>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                    Address Line 1
                  </label>
                  <input
                    type="text"
                    value={street}
                    onChange={(e) => setStreet(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                    Address Line 2{" "}
                    <span className="text-[#94a3b8] dark:text-white/30">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={street2}
                    onChange={(e) => setStreet2(e.target.value)}
                    placeholder="Apt, suite, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                    City
                  </label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                    State
                  </label>
                  <input
                    type="text"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
                    Zip Code
                  </label>
                  <input
                    type="text"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Notice */}
          <div className="flex items-center gap-2 text-xs text-[#64748b] dark:text-white/40">
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
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            Changes will be reflected on all bills for this vendor.
          </div>
        </div>

        {/* Actions */}
        <div className="bg-white dark:bg-[#1e293b] px-6 py-4 border-t border-[#e2e8f0] dark:border-white/10 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/60 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim() || mutation.isPending}
            className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-[#f59e0b] hover:bg-[#d97706] shadow-sm transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Vendor Combobox
// ============================================================================

export function VendorCombobox({
  vendorId,
  onSelect,
}: {
  vendorId: string;
  onSelect: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: allParties = [] } = useQuery({
    queryKey: ["parties", search],
    queryFn: () =>
      (listParties as (opts: { data: unknown }) => Promise<any[]>)({
        data: { search, limit: 20 },
      }),
  });

  const vendors = allParties.filter((p: any) => p.partyType === "vendor" || p.partyType === "both");

  const selectedVendor = allParties.find((v: any) => v.id === vendorId);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <>
      <div ref={containerRef} className="relative">
        <div className="relative">
          <input
            type="text"
            value={selectedVendor && !open ? selectedVendor.name : search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (vendorId) onSelect("", "");
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              if (selectedVendor) {
                setSearch("");
              }
            }}
            placeholder="Filter by name or email…"
            className="w-full px-3 py-2.5 pr-9 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
          />
          <svg
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-white/30 pointer-events-none"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>

        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-xl max-h-52 overflow-y-auto z-30">
            {vendors.length > 0 ? (
              vendors.map((v: any) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    onSelect(v.id, v.name);
                    setSearch(v.name);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors flex items-center gap-3 ${
                    v.id === vendorId
                      ? "bg-[#fffbeb] dark:bg-[#f59e0b]/10 text-[#f59e0b]"
                      : "text-[#1e293b] dark:text-white"
                  }`}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0"
                    style={{
                      backgroundColor: `hsl(${((v.name || "").charCodeAt(0) * 37) % 360}, 55%, 50%)`,
                    }}
                  >
                    {(v.name || "?")[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{v.name}</div>
                    {v.email && (
                      <div className="text-xs text-[#94a3b8] dark:text-white/40 truncate">
                        {v.email}
                      </div>
                    )}
                  </div>
                </button>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-[#94a3b8] dark:text-white/40">
                {search ? "No vendors found" : "No vendors yet"}
              </div>
            )}

            {/* Add Vendor action */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setShowNewModal(true);
              }}
              className="w-full text-left px-4 py-2.5 text-sm font-medium text-[#f59e0b] hover:bg-[#fffbeb] dark:hover:bg-amber-900/20 transition-colors border-t border-[#e2e8f0] dark:border-white/10 flex items-center gap-2.5"
            >
              <div className="w-5 h-5 rounded-full bg-[#f59e0b] flex items-center justify-center">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              Add Vendor
            </button>
          </div>
        )}
      </div>

      {showNewModal && (
        <NewVendorModal
          onClose={() => setShowNewModal(false)}
          onCreated={(v) => {
            onSelect(v.id, v.name);
            setSearch(v.name);
            setShowNewModal(false);
          }}
        />
      )}
    </>
  );
}
