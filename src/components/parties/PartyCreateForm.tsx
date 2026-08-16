/**
 * PartyCreateForm — Form for creating/editing all party types
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createParty, updateParty, uploadPartyAvatar } from "../../routes/api/-parties";
import type { PartyRecord } from "../../routes/api/-parties";
import { callServerFn } from "../../lib/server-fn-client";

// ============================================================================
// Types
// ============================================================================

export type PartyTypeValue =
  | "vendor"
  | "customer"
  | "both"
  | "employee"
  | "shareholder"
  | "lender"
  | "bank"
  | "government"
  | "other";

interface PartyFormData {
  name: string;
  partyType: PartyTypeValue;
  email: string;
  phone: string;
  website: string;
  logoUrl: string;
  address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  is1099Vendor: boolean;
  taxId: string;
  bankRoutingNumber: string;
  bankAccountNumber: string;
  mailingAddress: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

interface PartyCreateFormProps {
  partyType: PartyTypeValue;
  initialData?: PartyRecord;
  onClose: () => void;
}

type AddressFields = NonNullable<PartyRecord["address"]>;

// ============================================================================
// Component
// ============================================================================

export function PartyCreateForm({ partyType, initialData, onClose }: PartyCreateFormProps) {
  const queryClient = useQueryClient();
  const isEdit = !!initialData;
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialAddress: AddressFields = initialData?.address ?? {};
  const initialMailingAddress: AddressFields = initialData?.mailingAddress ?? {};

  const [form, setForm] = useState<PartyFormData>({
    name: initialData?.name ?? "",
    partyType: initialData?.partyType ?? partyType,
    email: initialData?.email ?? "",
    phone: initialData?.phone ?? "",
    website: initialData?.website ?? "",
    logoUrl: initialData?.logoUrl ?? "",
    address: {
      street: initialAddress.street ?? "",
      city: initialAddress.city ?? "",
      state: initialAddress.state ?? "",
      postalCode: initialAddress.postalCode ?? "",
      country: initialAddress.country ?? "",
    },
    is1099Vendor: initialData?.is1099Vendor ?? false,
    taxId: initialData?.taxId ?? "",
    bankRoutingNumber: initialData?.bankRoutingNumber ?? "",
    bankAccountNumber: initialData?.bankAccountNumber ?? "",
    mailingAddress: {
      street: initialMailingAddress.street ?? "",
      city: initialMailingAddress.city ?? "",
      state: initialMailingAddress.state ?? "",
      postalCode: initialMailingAddress.postalCode ?? "",
      country: initialMailingAddress.country ?? "",
    },
  });

  // Avatar helpers
  function getAvatarColor(name: string): string {
    const colors = [
      "#10b981",
      "#ec4899",
      "#f59e0b",
      "#3b82f6",
      "#8b5cf6",
      "#ef4444",
      "#14b8a6",
      "#f97316",
    ];
    let hash = 0;
    for (const c of name) hash = hash + c.charCodeAt(0);
    return colors[hash % colors.length];
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // For new parties without an ID, read as data URI for local preview
    if (!isEdit || !initialData) {
      const reader = new FileReader();
      reader.onload = () => updateField("logoUrl", reader.result as string);
      reader.readAsDataURL(file);
      return;
    }

    // For existing parties, upload to R2
    setUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1]);
        };
        reader.readAsDataURL(file);
      });

      const result = await callServerFn(uploadPartyAvatar, {
        data: {
          partyId: initialData.id,
          entityType: `${partyType === "government" ? "government" : partyType + "s"}`,
          filename: file.name,
          contentType: file.type,
          fileBase64: base64,
        },
      });
      updateField("logoUrl", result.logoUrl);
      queryClient.invalidateQueries({ queryKey: ["party", initialData.id] });
      queryClient.invalidateQueries({ queryKey: ["parties"] });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setErrors({ form: errMessage ?? "Avatar upload failed" });
    } finally {
      setUploading(false);
    }
  }

  function handleRemoveAvatar() {
    updateField("logoUrl", "");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function updateField<K extends keyof PartyFormData>(key: K, value: PartyFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function updateAddress(field: "address" | "mailingAddress", key: string, value: string) {
    setForm((prev) => ({
      ...prev,
      [field]: { ...prev[field], [key]: value },
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validate
    const newErrors: Record<string, string> = {};
    if (!form.name.trim()) newErrors.name = "Name is required";
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSaving(true);
    try {
      // Clean empty address fields
      const cleanAddr = (addr: typeof form.address) => {
        const hasValues = Object.values(addr).some((v) => v.trim());
        return hasValues ? addr : undefined;
      };

      const payload = {
        name: form.name.trim(),
        partyType: form.partyType,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        website: form.website.trim() || undefined,
        logoUrl: form.logoUrl.trim() || undefined,
        address: cleanAddr(form.address),
        is1099Vendor: form.is1099Vendor,
        taxId: form.taxId.trim() || undefined,
        bankRoutingNumber: form.bankRoutingNumber.trim() || undefined,
        bankAccountNumber: form.bankAccountNumber.trim() || undefined,
        mailingAddress: cleanAddr(form.mailingAddress),
      };

      if (isEdit && initialData) {
        await callServerFn(updateParty, {
          data: { id: initialData.id, ...payload },
        });
        queryClient.invalidateQueries({ queryKey: ["party", initialData.id] });
      } else {
        await callServerFn(createParty, {
          data: payload,
        });
      }

      queryClient.invalidateQueries({ queryKey: ["parties"] });
      onClose();
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setErrors({ form: errMessage ?? "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  const TYPE_LABELS: Record<PartyTypeValue, string> = {
    vendor: "Vendor",
    customer: "Customer",
    both: "Vendor/Customer",
    employee: "Employee",
    shareholder: "Shareholder",
    lender: "Lender",
    bank: "Bank",
    government: "Government",
    other: "Party",
  };
  const typeLabel = TYPE_LABELS[partyType];
  const isVendorLike = partyType === "vendor" || partyType === "both";

  return (
    <div className="flex-1 overflow-y-auto">
      <form onSubmit={handleSubmit}>
        {/* Header */}
        <div className="flex items-center justify-between px-8 h-[77px] border-b border-[#e2e8f0] dark:border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            {partyType === "vendor" || partyType === "both" ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[#10b981]"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            ) : partyType === "customer" ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[#10b981]"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            ) : partyType === "employee" ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[#10b981]"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
            ) : partyType === "shareholder" ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[#10b981]"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ) : partyType === "lender" ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[#10b981]"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <line x1="2" y1="10" x2="22" y2="10" />
              </svg>
            ) : partyType === "government" ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[#10b981]"
              >
                <path d="M3 21h18" />
                <path d="M5 21V7l7-4 7 4v14" />
                <path d="M9 21v-4h6v4" />
                <path d="M9 10h1" />
                <path d="M14 10h1" />
                <path d="M9 14h1" />
                <path d="M14 14h1" />
              </svg>
            ) : null}
            <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white">
              {isEdit ? `Edit ${typeLabel}` : `New ${typeLabel}`}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-9 min-h-11 lg:min-h-0 px-4 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/60 hover:bg-[#f1f5f9] dark:hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 h-9 min-h-11 lg:min-h-0 px-5 rounded-lg text-sm font-medium bg-gradient-to-r from-[#10b981] to-[#059669] text-white shadow-sm hover:shadow-md transition-all disabled:opacity-50"
            >
              {saving ? "Saving…" : isEdit ? "Save Changes" : `Create ${typeLabel}`}
            </button>
          </div>
        </div>

        {/* Form errors */}
        {errors.form && (
          <div className="mx-6 mt-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs">
            {errors.form}
          </div>
        )}

        <div className="p-6 space-y-6">
          {/* Basic Info */}
          <Section title="Basic Information">
            {/* Avatar Upload */}
            <div className="flex flex-col items-center mb-2">
              <div className="relative group">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-20 h-20 rounded-full overflow-hidden border-2 border-dashed border-[#e2e8f0] dark:border-white/15 hover:border-[#10b981] dark:hover:border-[#10b981] transition-colors cursor-pointer flex items-center justify-center relative"
                  title="Upload avatar"
                >
                  {uploading ? (
                    <div className="w-6 h-6 border-2 border-[#10b981] border-t-transparent rounded-full animate-spin" />
                  ) : form.logoUrl ? (
                    <img src={form.logoUrl} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <div
                      className="w-full h-full flex items-center justify-center text-white text-2xl font-bold"
                      style={{ backgroundColor: getAvatarColor(form.name || "?") }}
                    >
                      {(form.name || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-full">
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
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                  </div>
                </button>
                {/* Remove button */}
                {form.logoUrl && !uploading && (
                  <button
                    type="button"
                    onClick={handleRemoveAvatar}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-600 shadow-sm transition-colors"
                    title="Remove avatar"
                  >
                    ×
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <span className="text-[10px] text-[#94a3b8] dark:text-white/40 mt-1.5">
                Click to upload logo
              </span>
            </div>

            <FormField label="Name" required error={errors.name}>
              <input
                type="text"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder={`${typeLabel} name`}
                className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Email">
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField("email", e.target.value)}
                  placeholder="email@example.com"
                  className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                />
              </FormField>
              <FormField label="Phone">
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => updateField("phone", e.target.value)}
                  placeholder="(555) 123-4567"
                  className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                />
              </FormField>
            </div>
            <FormField label="Website">
              <input
                type="url"
                value={form.website}
                onChange={(e) => updateField("website", e.target.value)}
                placeholder="https://example.com"
                className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
              />
            </FormField>
          </Section>

          {/* Address */}
          <Section title="Address">
            <FormField label="Street">
              <input
                type="text"
                value={form.address.street}
                onChange={(e) => updateAddress("address", "street", e.target.value)}
                placeholder="123 Main St"
                className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
              />
            </FormField>
            <div className="grid grid-cols-3 gap-3">
              <FormField label="City">
                <input
                  type="text"
                  value={form.address.city}
                  onChange={(e) => updateAddress("address", "city", e.target.value)}
                  placeholder="City"
                  className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                />
              </FormField>
              <FormField label="State">
                <input
                  type="text"
                  value={form.address.state}
                  onChange={(e) => updateAddress("address", "state", e.target.value)}
                  placeholder="CA"
                  className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                />
              </FormField>
              <FormField label="Zip">
                <input
                  type="text"
                  value={form.address.postalCode}
                  onChange={(e) => updateAddress("address", "postalCode", e.target.value)}
                  placeholder="94111"
                  className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                />
              </FormField>
            </div>
          </Section>

          {/* Vendor Details (only for vendor-like types) */}
          {isVendorLike && (
            <Section title="Vendor Details">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is1099"
                  checked={form.is1099Vendor}
                  onChange={(e) => updateField("is1099Vendor", e.target.checked)}
                  className="w-4 h-4 rounded border-[#e2e8f0] dark:border-white/20 accent-[#10b981]"
                />
                <label htmlFor="is1099" className="text-sm text-[#1e293b] dark:text-white">
                  1099 Vendor
                </label>
              </div>
              {form.is1099Vendor && (
                <FormField label="Tax ID (EIN/SSN)">
                  <input
                    type="text"
                    value={form.taxId}
                    onChange={(e) => updateField("taxId", e.target.value)}
                    placeholder="XX-XXXXXXX"
                    className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                  />
                </FormField>
              )}
            </Section>
          )}

          {/* Bank / Payment Info (vendor-like types) */}
          {isVendorLike && (
            <Section title="Payment Information">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Bank Routing Number">
                  <input
                    type="text"
                    value={form.bankRoutingNumber}
                    onChange={(e) => updateField("bankRoutingNumber", e.target.value)}
                    placeholder="XXXXXXXXX"
                    className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                  />
                </FormField>
                <FormField label="Bank Account Number">
                  <input
                    type="text"
                    value={form.bankAccountNumber}
                    onChange={(e) => updateField("bankAccountNumber", e.target.value)}
                    placeholder="XXXXXXXXXXXX"
                    className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                  />
                </FormField>
              </div>

              <div className="mt-3">
                <h4 className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
                  Mailing Address (for checks)
                </h4>
                <FormField label="Street">
                  <input
                    type="text"
                    value={form.mailingAddress.street}
                    onChange={(e) => updateAddress("mailingAddress", "street", e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                  />
                </FormField>
                <div className="grid grid-cols-3 gap-3 mt-2">
                  <FormField label="City">
                    <input
                      type="text"
                      value={form.mailingAddress.city}
                      onChange={(e) => updateAddress("mailingAddress", "city", e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                    />
                  </FormField>
                  <FormField label="State">
                    <input
                      type="text"
                      value={form.mailingAddress.state}
                      onChange={(e) => updateAddress("mailingAddress", "state", e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                    />
                  </FormField>
                  <FormField label="Zip">
                    <input
                      type="text"
                      value={form.mailingAddress.postalCode}
                      onChange={(e) =>
                        updateAddress("mailingAddress", "postalCode", e.target.value)
                      }
                      className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                    />
                  </FormField>
                </div>
              </div>
            </Section>
          )}
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function FormField({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[#64748b] dark:text-white/50 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-red-500 text-[11px] mt-0.5">{error}</p>}
    </div>
  );
}
