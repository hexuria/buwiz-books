/**
 * PartyDetailPanel — Right-hand detail view for a selected vendor/customer
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getParty, deleteParty, hardDeleteParty, restoreParty } from "../../routes/api/-parties";
import { useState } from "react";
import { ConfirmModal } from "../shared/ConfirmModal";
import { callServerFn } from "../../lib/server-fn-client";

// ============================================================================
// Helpers
// ============================================================================

function getAvatarColor(name: string): string {
  const colors = [
    "#10b981",
    "#ec4899",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ef4444",
    "#14b8a6",
  ];
  let hash = 0;
  for (const c of name) hash = hash + c.charCodeAt(0);
  return colors[hash % colors.length];
}

function formatAddress(addr: {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}): string {
  const parts = [
    addr.street,
    [addr.city, addr.state, addr.postalCode].filter(Boolean).join(", "),
    addr.country,
  ].filter(Boolean);
  return parts.join("\n");
}

// ============================================================================
// Component
// ============================================================================

interface PartyDetailPanelProps {
  partyId: string;
  onEdit: () => void;
  onDeleted: () => void;
}

export function PartyDetailPanel({ partyId, onEdit, onDeleted }: PartyDetailPanelProps) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"deactivate" | "delete" | "restore" | null>(
    null,
  );

  const { data: party, isLoading } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => callServerFn(getParty, { data: { id: partyId } }),
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-[#94a3b8] dark:text-white/40 animate-pulse">Loading…</div>
      </div>
    );
  }

  if (!party) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-[#94a3b8] dark:text-white/40">Party not found</div>
      </div>
    );
  }

  const isVendor = party.partyType === "vendor" || party.partyType === "both";
  const color = getAvatarColor(party.name);
  const PARTY_LABELS: Record<string, string> = {
    vendor: "Vendor",
    customer: "Customer",
    both: "Vendor & Customer",
    employee: "Employee",
    shareholder: "Shareholder",
    lender: "Lender",
    government: "Government",
    other: "Other",
  };
  const partyLabel = PARTY_LABELS[party.partyType] ?? party.partyType;

  async function handleDeactivate() {
    setDeleting(true);
    try {
      await callServerFn(deleteParty, { data: { id: partyId } });
      queryClient.invalidateQueries({ queryKey: ["parties"] });
      queryClient.invalidateQueries({ queryKey: ["party", partyId] });
      setConfirmAction(null);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  async function handlePermanentDelete() {
    setDeleting(true);
    try {
      await callServerFn(hardDeleteParty, { data: { id: partyId } });
      queryClient.invalidateQueries({ queryKey: ["parties"] });
      setConfirmAction(null);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  async function handleRestore() {
    setDeleting(true);
    try {
      await callServerFn(restoreParty, { data: { id: partyId } });
      queryClient.invalidateQueries({ queryKey: ["parties"] });
      queryClient.invalidateQueries({ queryKey: ["party", partyId] });
      setConfirmAction(null);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Action Buttons Row */}
      {/* `pl-16` clears the layout's absolutely-positioned sidebar toggle, which is a 44px target
          below `lg`; `flex-wrap` keeps the buttons on-screen at 375px once that gutter is gone. */}
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 pl-16 pt-4 pb-3 border-b border-[#e2e8f0] dark:border-white/10 sm:px-6 sm:pl-16">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/60 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
        >
          Edit
        </button>
        {party.isActive ? (
          <button
            type="button"
            onClick={() => setConfirmAction("deactivate")}
            className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-3 py-1.5 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Deactivate
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirmAction("restore")}
              className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={() => setConfirmAction("delete")}
              className="inline-flex min-h-11 items-center justify-center lg:min-h-0 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {/* Avatar, Name & Badge */}
      <div className="px-4 py-5 border-b border-[#e2e8f0] dark:border-white/10 sm:px-6">
        <div className="flex items-center gap-3 sm:gap-4">
          {party.logoUrl ? (
            <img
              src={party.logoUrl}
              alt={party.name}
              className="w-14 h-14 rounded-xl object-cover shrink-0"
            />
          ) : (
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center text-white text-xl font-bold shrink-0"
              style={{ backgroundColor: color }}
            >
              {party.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-lg sm:text-xl font-semibold text-[#1e293b] dark:text-white truncate">
              {party.name}
            </h2>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span
                className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                  party.partyType === "customer"
                    ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400"
                    : party.partyType === "both"
                      ? "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
                      : "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
                }`}
              >
                {party.partyType === "both"
                  ? "Vendor & Customer"
                  : party.partyType.charAt(0).toUpperCase() + party.partyType.slice(1)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* View Insights Link */}
      <div className="px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10 sm:px-6">
        <Link
          to={`/entities/${party.partyType}/${party.id}` as string & {}}
          className="flex items-center justify-between w-full px-4 py-3 rounded-xl bg-gradient-to-r from-[#f0fdfa] to-[#ecfdf5] dark:from-slate-800 dark:to-slate-800 border border-[#d1fae5] dark:border-slate-700 hover:border-[#14b8a6] transition-colors no-underline group"
        >
          <div className="flex items-center gap-2.5">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#14b8a6"
              strokeWidth="2"
            >
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
            <span className="text-sm font-medium text-[#0d9488]">View Insights</span>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2"
            className="group-hover:translate-x-0.5 transition-transform"
          >
            <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>

      {/* Contact Section */}
      <div className="p-4 border-b border-[#e2e8f0] dark:border-white/10 sm:p-6">
        <h3 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
          Contact
        </h3>
        <div className="space-y-2.5">
          <InfoRow
            icon={
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
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            }
            label="Email"
            value={party.email || "Not set"}
          />
          <InfoRow
            icon={
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
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            }
            label="Phone"
            value={party.phone || "Not set"}
          />
          <InfoRow
            icon={
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
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            }
            label="Website"
            value={party.website || "Not set"}
          />
          <InfoRow
            icon={
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
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            }
            label="Address"
            value={party.address ? formatAddress(party.address) : "Not set"}
          />
        </div>
      </div>

      {/* Vendor-specific info */}
      {isVendor && (
        <div className="p-4 border-b border-[#e2e8f0] dark:border-white/10 sm:p-6">
          <h3 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
            Vendor Details
          </h3>
          <div className="space-y-2.5">
            <InfoRow label="1099 Vendor" value={party.is1099Vendor ? "Yes" : "No"} />
            <InfoRow label="Tax ID" value={party.taxId ? "••••••" : "Not set"} />
            <InfoRow label="Default Account" value={party.defaultAccountName ?? "Not set"} />
          </div>
        </div>
      )}

      {/* Payment Info */}
      {isVendor && (
        <div className="p-4 border-b border-[#e2e8f0] dark:border-white/10 sm:p-6">
          <h3 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
            Payment Info
          </h3>
          <div className="space-y-2.5">
            <InfoRow
              label="Bank Routing"
              value={
                party.bankRoutingNumber ? `••••${party.bankRoutingNumber.slice(-4)}` : "Not set"
              }
            />
            <InfoRow
              label="Bank Account"
              value={
                party.bankAccountNumber ? `••••${party.bankAccountNumber.slice(-4)}` : "Not set"
              }
            />
            <InfoRow
              label="Mailing Address"
              value={party.mailingAddress ? formatAddress(party.mailingAddress) : "Not set"}
            />
          </div>
        </div>
      )}

      {/* Notes */}
      {(party.description || party.notes) && (
        <div className="p-4 sm:p-6">
          <h3 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
            Notes
          </h3>
          <p className="text-sm text-[#64748b] dark:text-white/60 whitespace-pre-wrap break-words">
            {party.description || party.notes}
          </p>
        </div>
      )}

      {/* Confirmation Modals */}
      {confirmAction === "deactivate" && (
        <ConfirmModal
          title={`Deactivate ${partyLabel}`}
          subtitle={`This ${partyLabel.toLowerCase()} will be hidden from lists`}
          message={
            <>
              Are you sure you want to deactivate <strong>{party.name}</strong>? You can view
              deactivated {partyLabel.toLowerCase()}s using the status filter, and restore them at
              any time.
            </>
          }
          confirmLabel="Deactivate"
          onConfirm={handleDeactivate}
          onCancel={() => setConfirmAction(null)}
          isLoading={deleting}
          destructive
          icon={
            <svg
              style={{ width: 24, height: 24, color: "#dc2626" }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <title>Deactivate</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M18.36 6.64A9 9 0 1 1 5.64 6.64m6.36-3.14v10"
              />
            </svg>
          }
        />
      )}
      {confirmAction === "delete" && (
        <ConfirmModal
          title={`Delete ${partyLabel}`}
          subtitle="This action cannot be undone"
          message={
            <>
              Are you sure you want to permanently delete <strong>{party.name}</strong>? All data
              associated with this {partyLabel.toLowerCase()} will be removed.
            </>
          }
          confirmLabel="Delete"
          onConfirm={handlePermanentDelete}
          onCancel={() => setConfirmAction(null)}
          isLoading={deleting}
          destructive
        />
      )}
      {confirmAction === "restore" && (
        <ConfirmModal
          title={`Restore ${partyLabel}`}
          subtitle={`This ${partyLabel.toLowerCase()} will be reactivated`}
          message={
            <>
              Are you sure you want to restore <strong>{party.name}</strong>? They will appear in
              your active {partyLabel.toLowerCase()}s list again.
            </>
          }
          confirmLabel="Restore"
          onConfirm={handleRestore}
          onCancel={() => setConfirmAction(null)}
          isLoading={deleting}
          destructive={false}
        />
      )}
    </div>
  );
}

// ============================================================================
// InfoRow Sub-component
// ============================================================================

function InfoRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      {icon && (
        <span className="w-5 h-5 flex items-center justify-center shrink-0 text-[#94a3b8] dark:text-white/40 mt-0.5">
          {icon}
        </span>
      )}
      {!icon && <span className="w-5 shrink-0" />}
      <div className="min-w-0">
        <div className="text-xs font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wide">
          {label}
        </div>
        {/* `break-words`: an unspaced email or URL is the one value here that can push the panel
            wider than a 375px viewport, which the app shell clips rather than scrolls. */}
        <div className="text-sm text-[#1e293b] dark:text-white whitespace-pre-line break-words">
          {value}
        </div>
      </div>
    </div>
  );
}
