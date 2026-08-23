/**
 * Organization Settings — /organization/$orgId/settings
 * Linear-style full-page settings with sidebar navigation.
 * Sections: General, AI Credentials, Members
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useSession } from "@/lib/auth-client";
import {
  getOrgSettings,
  updateOrgGeminiKeys,
  updateOrgName,
  listOrgMembers,
  updateMemberRole,
  removeOrgMember,
  createInvitation,
  listInvitations,
  updateOrgEmailSettings,
  getOwnerEmail,
  updateOrgBusinessInfo,
  updateOrgImageGenerationSetting,
  getOrgAiCredentials,
  addOrgAiCredential,
  revokeOrgAiCredential,
  getOrgAiSettingsForUi,
  updateOrgAiSettings,
} from "./api/-org-settings";
import type {
  OrgSettings,
  OrgMember,
  OrgInvitation,
  OrgAiConfigView,
  OrgAiCredentialView,
} from "./api/-org-settings";
import { ExportImportSection } from "../components/settings/ExportImportSection";
import { CURRENCIES } from "@/lib/constants";
import Combobox from "@/components/ui/Combobox";
import { AI_MODEL_OPTIONS, AI_MODEL_DEFAULTS, AI_TASK_LABELS } from "@/lib/ai-models";
import type { AITaskCategory } from "@/lib/ai-models";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/organization/$orgId/settings")({
  component: SettingsPage,
});

// ============================================================================
// Constants
// ============================================================================

type SettingsSection =
  | "general"
  | "business"
  | "email"
  | "ai-credentials"
  | "members"
  | "export-import";

const SECTIONS: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
  {
    key: "general",
    label: "General",
    icon: (
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    key: "business",
    label: "Business Profile",
    icon: (
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
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    key: "email",
    label: "Email",
    icon: (
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
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </svg>
    ),
  },
  {
    key: "ai-credentials",
    label: "AI Credentials",
    icon: (
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
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    key: "members",
    label: "Members",
    icon: (
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
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    key: "export-import",
    label: "Export / Import",
    icon: (
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
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      </svg>
    ),
  },
];

// ============================================================================
// Page Component
// ============================================================================

function SettingsPage() {
  const { data: session } = useSession();
  const { orgId } = Route.useParams();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<SettingsSection>("general");

  // Fetch settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () =>
      (getOrgSettings as (opts: { data: unknown }) => Promise<OrgSettings>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  // Fetch members
  const { data: members = [] } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => (listOrgMembers as () => Promise<OrgMember[]>)(),
    enabled: !!orgId,
  });

  return (
    <div className="min-h-screen bg-[#f1f5f9] dark:bg-[#0c1322] overflow-y-auto">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#111827]/80 backdrop-blur-md border-b border-[#e2e8f0] dark:border-white/10">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 h-14 flex items-center">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-[#0d9488] hover:text-[#0f766e] dark:text-teal-400 dark:hover:text-teal-300 font-medium transition-colors no-underline"
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
            Back to app
          </Link>
          <h1 className="ml-6 text-lg font-semibold text-[#1e293b] dark:text-white">
            Organization Settings
          </h1>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-8">
        {/* Sidebar */}
        <aside className="w-52 shrink-0">
          <nav className="sticky top-24 space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  section === s.key
                    ? "bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400"
                    : "text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 hover:text-[#1e293b] dark:hover:text-white"
                }`}
              >
                <span className="w-4 h-4 flex items-center justify-center">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0">
          {isLoading || !settings ? (
            <SettingsSkeleton />
          ) : (
            <>
              {section === "general" && (
                <GeneralSection settings={settings} orgId={orgId} queryClient={queryClient} />
              )}
              {section === "business" && (
                <BusinessProfileSection
                  settings={settings}
                  orgId={orgId}
                  queryClient={queryClient}
                />
              )}
              {section === "email" && (
                <EmailSection settings={settings} orgId={orgId} queryClient={queryClient} />
              )}
              {section === "ai-credentials" && (
                <AICredentialsSection settings={settings} orgId={orgId} queryClient={queryClient} />
              )}
              {section === "members" && (
                <MembersSection
                  members={members}
                  orgId={orgId}
                  queryClient={queryClient}
                  currentUserId={session?.user?.id}
                />
              )}
              {section === "export-import" && <ExportImportSection />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// General Section
// ============================================================================

function GeneralSection({
  settings,
  orgId,
  queryClient,
}: {
  settings: OrgSettings;
  orgId: string;
  queryClient: any;
}) {
  const [name, setName] = useState(settings?.name ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setName(settings.name);
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (newName: string) =>
      (updateOrgName as (opts: { data: unknown }) => Promise<unknown>)({
        data: { organizationId: orgId, name: newName },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">General</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Manage your organization&apos;s basic information.
      </p>

      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6">
        <div className="space-y-5">
          {/* Logo placeholder */}
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-[#0d9488] to-[#0f766e] flex items-center justify-center text-white text-xl font-bold shrink-0">
              {settings?.name?.charAt(0)?.toUpperCase() ?? "O"}
            </div>
            <div>
              <p className="text-sm font-medium text-[#1e293b] dark:text-white">
                Organization Logo
              </p>
              <p className="text-xs text-[#94a3b8] dark:text-white/40">
                Recommended size is 256×256px
              </p>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              Name
            </label>
            <div className="flex gap-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
              />
              <button
                type="button"
                onClick={() => mutation.mutate(name)}
                disabled={mutation.isPending || name === settings?.name}
                className="px-4 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
              >
                {mutation.isPending ? "Saving…" : saved ? "Saved ✓" : "Save"}
              </button>
            </div>
          </div>

          {/* Slug (read-only) */}
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              URL Slug
            </label>
            <div className="px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] text-sm text-[#94a3b8] dark:text-white/40">
              {settings?.slug ?? "—"}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ============================================================================
// Business Profile Section
// ============================================================================

function BusinessProfileSection({
  settings,
  orgId,
  queryClient,
}: {
  settings: OrgSettings;
  orgId: string;
  queryClient: any;
}) {
  const [phone, setPhone] = useState(settings?.phone ?? "");
  const [website, setWebsite] = useState(settings?.website ?? "");
  const [taxId, setTaxId] = useState(settings?.taxId ?? "");
  const [addressStreet, setAddressStreet] = useState(settings?.addressStreet ?? "");
  const [addressCity, setAddressCity] = useState(settings?.addressCity ?? "");
  const [addressState, setAddressState] = useState(settings?.addressState ?? "");
  const [addressPostalCode, setAddressPostalCode] = useState(settings?.addressPostalCode ?? "");
  const [addressCountry, setAddressCountry] = useState(settings?.addressCountry ?? "");
  const [logoUrl, setLogoUrl] = useState(settings?.logoUrl ?? "");
  const [currency, setCurrency] = useState(settings?.currency ?? "USD");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setPhone(settings.phone ?? "");
      setWebsite(settings.website ?? "");
      setTaxId(settings.taxId ?? "");
      setAddressStreet(settings.addressStreet ?? "");
      setAddressCity(settings.addressCity ?? "");
      setAddressState(settings.addressState ?? "");
      setAddressPostalCode(settings.addressPostalCode ?? "");
      setAddressCountry(settings.addressCountry ?? "");
      setLogoUrl(settings.logoUrl ?? "");
      setCurrency(settings.currency ?? "USD");
    }
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (data: Record<string, string>) =>
      (updateOrgBusinessInfo as (opts: { data: unknown }) => Promise<unknown>)({
        data: { organizationId: orgId, ...data },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSave = () => {
    mutation.mutate({
      phone,
      website,
      taxId,
      addressStreet,
      addressCity,
      addressState,
      addressPostalCode,
      addressCountry,
      logoUrl,
      currency,
    });
  };

  const hasChanges =
    phone !== (settings?.phone ?? "") ||
    website !== (settings?.website ?? "") ||
    taxId !== (settings?.taxId ?? "") ||
    addressStreet !== (settings?.addressStreet ?? "") ||
    addressCity !== (settings?.addressCity ?? "") ||
    addressState !== (settings?.addressState ?? "") ||
    addressPostalCode !== (settings?.addressPostalCode ?? "") ||
    addressCountry !== (settings?.addressCountry ?? "") ||
    logoUrl !== (settings?.logoUrl ?? "") ||
    currency !== (settings?.currency ?? "USD");

  const inputClass =
    "w-full px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all";

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">
        Business Profile
      </h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Your company identity used on invoices and official documents.
      </p>

      {/* Contact & Tax */}
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
          Contact &amp; Tax
        </h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              Phone
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 123-4567"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              Website
            </label>
            <input
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com"
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Tax ID / EIN
          </label>
          <input
            type="text"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder="12-3456789"
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Logo URL
          </label>
          <input
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://example.com/logo.png"
            className={inputClass}
          />
        </div>
      </section>

      {/* Currency */}
      <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
          Functional Currency
        </h3>

        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Currency
          </label>
          <Combobox
            value={currency}
            onChange={setCurrency}
            onSearch={(_q) => {}}
            options={[...CURRENCIES]}
            placeholder="Select currency..."
            searchPlaceholder="Search currency..."
            className="w-full"
            displayValue={CURRENCIES.find((c) => c.value === currency)?.label || currency}
            onCreate={(query) => {
              const upper = query.toUpperCase();
              setCurrency(upper);
            }}
            createLabel="currency code"
          />
          <p className="mt-2 text-xs text-[#94a3b8] dark:text-white/40">
            Changing your functional currency will update correct formatting on dashboard numbers,
            but does <strong>not</strong> perform currency conversion on existing data.
          </p>
        </div>
      </section>

      {/* Address */}
      <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          Business Address
        </h3>

        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Street Address
          </label>
          <input
            type="text"
            value={addressStreet}
            onChange={(e) => setAddressStreet(e.target.value)}
            placeholder="123 Main St, Suite 100"
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              City
            </label>
            <input
              type="text"
              value={addressCity}
              onChange={(e) => setAddressCity(e.target.value)}
              placeholder="San Francisco"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              State / Province
            </label>
            <input
              type="text"
              value={addressState}
              onChange={(e) => setAddressState(e.target.value)}
              placeholder="CA"
              className={inputClass}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              Postal Code
            </label>
            <input
              type="text"
              value={addressPostalCode}
              onChange={(e) => setAddressPostalCode(e.target.value)}
              placeholder="94105"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
              Country
            </label>
            <input
              type="text"
              value={addressCountry}
              onChange={(e) => setAddressCountry(e.target.value)}
              placeholder="United States"
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Save button */}
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={mutation.isPending || !hasChanges}
          className="px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
        >
          {mutation.isPending ? "Saving..." : saved ? "Saved ✓" : "Save Changes"}
        </button>

        {saved && (
          <span className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
            Business profile saved successfully
          </span>
        )}

        {mutation.isError && (
          <span className="text-xs text-[#ef4444] dark:text-red-400 font-medium">
            Failed to save. Please try again.
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Email Section
// ============================================================================

function EmailSection({
  settings,
  orgId,
  queryClient,
}: {
  settings: OrgSettings;
  orgId: string;
  queryClient: any;
}) {
  const [senderName, setSenderName] = useState(settings?.emailSenderName ?? "");
  const [senderEmail, setSenderEmail] = useState(settings?.emailSenderEmail ?? "");
  const [resendApiKey, setResendApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [showResendKey, setShowResendKey] = useState(false);

  // Fetch owner email for placeholder
  const { data: ownerInfo } = useQuery({
    queryKey: ["org-owner", orgId],
    queryFn: () =>
      (
        getOwnerEmail as (opts: {
          data: unknown;
        }) => Promise<{ email: string; name: string } | null>
      )({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  useEffect(() => {
    if (settings) {
      setSenderName(settings.emailSenderName ?? "");
      setSenderEmail(settings.emailSenderEmail ?? "");
      setResendApiKey(""); // secret — not returned by server; user must re-enter to change
    }
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (data: {
      emailSenderName: string;
      emailSenderEmail: string;
      resendApiKey: string;
    }) =>
      (updateOrgEmailSettings as (opts: { data: unknown }) => Promise<unknown>)({
        data: { organizationId: orgId, ...data },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSave = () => {
    mutation.mutate({ emailSenderName: senderName, emailSenderEmail: senderEmail, resendApiKey });
  };

  const hasChanges =
    senderName !== (settings?.emailSenderName ?? "") ||
    senderEmail !== (settings?.emailSenderEmail ?? "") ||
    resendApiKey !== "";

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">Email</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Configure sender identity and email delivery for invoices and notifications.
      </p>

      {/* Sender Identity */}
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          Sender Identity
        </h3>

        {/* Info callout */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488] dark:text-teal-400 mt-0.5 shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <p className="text-xs text-[#0d9488] dark:text-teal-300">
            These values appear as the &quot;From&quot; name and email on invoices. If left empty,
            the sender name defaults to the organization name, and the sender email defaults to the
            owner&apos;s email address.
          </p>
        </div>

        {/* Sender Name */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Sender Name
          </label>
          <input
            type="text"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            placeholder={settings?.name ?? "Organization Name"}
            className="w-full px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          />
          <p className="mt-1 text-[11px] text-[#94a3b8] dark:text-white/30">
            Defaults to: {settings?.name || "Organization Name"}
          </p>
        </div>

        {/* Sender Email */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Sender Email
          </label>
          <input
            type="email"
            value={senderEmail}
            onChange={(e) => setSenderEmail(e.target.value)}
            placeholder={ownerInfo?.email ?? "owner@example.com"}
            className="w-full px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          />
          <p className="mt-1 text-[11px] text-[#94a3b8] dark:text-white/30">
            Defaults to: {ownerInfo?.email ?? "owner's email"}
          </p>
        </div>
      </section>

      {/* Resend API Key */}
      <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Email Delivery (Resend)
        </h3>

        {/* Info */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488] dark:text-teal-400 mt-0.5 shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <p className="text-xs text-[#0d9488] dark:text-teal-300">
            Provide your Resend API key to enable sending invoice emails. If not set, the system
            falls back to the environment variable. Get your API key from{" "}
            <a
              href="https://resend.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline hover:text-[#0f766e] dark:hover:text-teal-200"
            >
              resend.com
            </a>
            .
          </p>
        </div>

        {/* API Key input */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Resend API Key
          </label>
          <div className="relative">
            <input
              type={showResendKey ? "text" : "password"}
              value={resendApiKey}
              onChange={(e) => setResendApiKey(e.target.value)}
              placeholder="re_..."
              className="w-full px-4 py-2.5 pr-20 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] font-mono focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
            />
            <button
              type="button"
              onClick={() => setShowResendKey(!showResendKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-medium text-[#64748b] hover:text-[#1e293b] dark:text-white/40 dark:hover:text-white transition-colors"
            >
              {showResendKey ? "Hide" : "Show"}
            </button>
          </div>
          {settings?.resendApiKeySet && !resendApiKey && (
            <p className="mt-1 text-[11px] text-[#94a3b8] dark:text-white/30">
              A key is currently configured. Enter a new value to replace it.
            </p>
          )}
        </div>
      </section>

      {/* Save button */}
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={mutation.isPending || !hasChanges}
          className="px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
        >
          {mutation.isPending ? "Saving..." : saved ? "Saved" : "Save Changes"}
        </button>

        {saved && (
          <span className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
            Settings saved successfully
          </span>
        )}

        {mutation.isError && (
          <span className="text-xs text-[#ef4444] dark:text-red-400 font-medium">
            Failed to save. Please try again.
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// AI Credentials Section
// ============================================================================

function AICredentialsSection({
  settings,
  orgId,
  queryClient,
}: {
  settings: OrgSettings;
  orgId: string;
  queryClient: any;
}) {
  const [keys, setKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [ocrModel, setOcrModel] = useState<string>("");
  const [textModel, setTextModel] = useState<string>("");
  const [imageModel, setImageModel] = useState<string>("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setKeys(settings.geminiApiKeys ?? []);
      setOcrModel(settings.aiModelOcr ?? "");
      setTextModel(settings.aiModelTextAnalysis ?? "");
      setImageModel(settings.aiModelImageGen ?? "");
    }
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (args: {
      keys: string[];
      aiModelOcr?: string;
      aiModelTextAnalysis?: string;
      aiModelImageGen?: string;
    }) =>
      (updateOrgGeminiKeys as (opts: { data: unknown }) => Promise<unknown>)({
        data: {
          organizationId: orgId,
          keys: args.keys,
          aiModelOcr: args.aiModelOcr,
          aiModelTextAnalysis: args.aiModelTextAnalysis,
          aiModelImageGen: args.aiModelImageGen,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const addKey = () => {
    const trimmed = newKey.trim();
    if (!trimmed || keys.includes(trimmed)) return;
    const updated = [...keys, trimmed];
    setKeys(updated);
    setNewKey("");
    mutation.mutate({
      keys: updated,
      aiModelOcr: ocrModel,
      aiModelTextAnalysis: textModel,
      aiModelImageGen: imageModel,
    });
  };

  const removeKey = (idx: number) => {
    const updated = keys.filter((_, i) => i !== idx);
    setKeys(updated);
    mutation.mutate({
      keys: updated,
      aiModelOcr: ocrModel,
      aiModelTextAnalysis: textModel,
      aiModelImageGen: imageModel,
    });
  };

  const handleTaskModelChange = (task: AITaskCategory, value: string) => {
    switch (task) {
      case "ocr":
        setOcrModel(value);
        break;
      case "textAnalysis":
        setTextModel(value);
        break;
      case "imageGen":
        setImageModel(value);
        break;
    }
    mutation.mutate({
      keys,
      aiModelOcr: task === "ocr" ? value : ocrModel,
      aiModelTextAnalysis: task === "textAnalysis" ? value : textModel,
      aiModelImageGen: task === "imageGen" ? value : imageModel,
    });
  };

  const maskKey = (key: string) => {
    if (key.length <= 8) return "••••" + key.slice(-4);
    return key.slice(0, 4) + "••••••••" + key.slice(-4);
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">AI Credentials</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Manage your Gemini API keys for AI-powered features like bill OCR and date parsing. Keys are
        rotated automatically when rate limits are hit.
      </p>

      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        {/* Info */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488] dark:text-teal-400 mt-0.5 shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <p className="text-xs text-[#0d9488] dark:text-teal-300">
            Add your Gemini API keys here. These keys are used for AI-powered features like bill OCR
            and date parsing. Get free keys from{" "}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline hover:text-[#0f766e] dark:hover:text-teal-200"
            >
              Google AI Studio
            </a>
            .
          </p>
        </div>

        {/* Current keys — scrollable container */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-2">
            API Keys ({keys.length})
          </label>

          {keys.length === 0 ? (
            <div className="text-center py-6 text-sm text-[#94a3b8] dark:text-white/30">
              No API keys configured. Add at least one key to enable AI features.
            </div>
          ) : (
            <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
              {keys.map((key, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] group"
                >
                  <span className="flex-1 font-mono text-xs text-[#64748b] dark:text-white/50 tracking-wide">
                    {maskKey(key)}
                  </span>
                  <span className="text-[10px] font-medium text-[#0d9488] dark:text-teal-400 bg-[#0d9488]/10 dark:bg-teal-900/30 px-2 py-0.5 rounded-full">
                    Key {idx + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeKey(idx)}
                    className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-all"
                    title="Remove key"
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
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add new key */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Add New Key
          </label>
          <div className="flex gap-3">
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addKey()}
              placeholder="AIzaSy..."
              className="flex-1 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] font-mono focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
            />
            <button
              type="button"
              onClick={addKey}
              disabled={!newKey.trim() || mutation.isPending}
              className="px-5 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all flex items-center gap-2"
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
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add
            </button>
          </div>
        </div>

        {/* Status */}
        {saved && (
          <div className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
            ✓ Keys saved successfully
          </div>
        )}

        {mutation.isError && (
          <div className="text-xs text-[#ef4444] dark:text-red-400 font-medium">
            Failed to save keys. Please try again.
          </div>
        )}
      </section>

      {/* Other providers (Anthropic / OpenAI / OpenAI-compatible) */}
      <OtherProvidersSection orgId={orgId} queryClient={queryClient} />

      {/* Provider allowlist, effective chains, kill switch, spend cap */}
      <AiGovernanceSection orgId={orgId} queryClient={queryClient} />

      {/* Per-Task AI Model Configuration */}
      <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
            AI Model Configuration
          </h3>
          <p className="text-xs text-[#64748b] dark:text-white/50">
            Select which Gemini model to use for each AI task. Different tasks benefit from
            different models.
          </p>
        </div>

        {(["ocr", "textAnalysis", "imageGen"] as AITaskCategory[]).map((task) => {
          const label = AI_TASK_LABELS[task];
          const options = AI_MODEL_OPTIONS[task];
          const currentValue =
            task === "ocr" ? ocrModel : task === "textAnalysis" ? textModel : imageModel;
          const defaultVal = AI_MODEL_DEFAULTS[task];

          return (
            <div
              key={task}
              className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-3.5 rounded-xl bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/5"
            >
              <div className="flex items-start gap-3">
                <span className="text-lg mt-0.5">{label.icon}</span>
                <div>
                  <p className="text-sm font-medium text-[#1e293b] dark:text-white">
                    {label.title}
                  </p>
                  <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
                    {label.description}
                  </p>
                </div>
              </div>
              <select
                id={`ai-model-${task}`}
                value={currentValue || defaultVal}
                onChange={(e) => handleTaskModelChange(task, e.target.value)}
                className="w-full md:w-64 px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
                disabled={mutation.isPending}
              >
                {options.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name}
                    {opt.recommended ? " ✦" : ""}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </section>

      {/* AI Image Generation Toggle */}
      <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
              AI Image Generation
            </h3>
            <p className="text-xs text-[#64748b] dark:text-white/50">
              Generate document thumbnails using Gemini AI for non-image file types like PDFs, Word
              docs, and spreadsheets.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !settings.enableImageGeneration;
              (updateOrgImageGenerationSetting as (opts: { data: unknown }) => Promise<unknown>)({
                data: { organizationId: orgId, enabled: next },
              }).then(() => {
                queryClient.invalidateQueries({ queryKey: ["org-settings"] });
              });
            }}
            className={`touch-target relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 ${
              settings.enableImageGeneration ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/10"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                settings.enableImageGeneration ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </section>

      {/* How it works */}
      <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-3">
          How key rotation works
        </h3>
        <ul className="space-y-2 text-xs text-[#64748b] dark:text-white/50">
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400 flex items-center justify-center shrink-0 text-[10px] font-bold mt-0">
              1
            </span>
            Keys are rotated in round-robin order across all configured keys
          </li>
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400 flex items-center justify-center shrink-0 text-[10px] font-bold mt-0">
              2
            </span>
            When a key hits a rate limit (HTTP 429), the system retries with the next key
          </li>
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400 flex items-center justify-center shrink-0 text-[10px] font-bold mt-0">
              3
            </span>
            Exponential backoff (1s → 2s → 4s) with up to 3 retries before showing an error
          </li>
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400 flex items-center justify-center shrink-0 text-[10px] font-bold mt-0">
              4
            </span>
            More keys = higher throughput. Get keys from{" "}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#0d9488] dark:text-teal-400 hover:underline"
            >
              Google AI Studio
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}

// ============================================================================
// Multi-provider AI credentials + governance
//
// Gemini keeps the multi-key editor above (it is still stored in
// organization_secrets). Anthropic / OpenAI / OpenAI-compatible are row-based
// BYOK credentials: add + revoke, masked display only.
// ============================================================================

type AiProviderId = "gemini" | "anthropic" | "openai" | "openai_compatible";

const AI_PROVIDER_META: {
  id: AiProviderId;
  name: string;
  blurb: string;
  needsBaseUrl?: boolean;
  keyPlaceholder: string;
}[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    blurb: "Runs every document and OCR task. Managed in the API Keys panel above.",
    keyPlaceholder: "AIzaSy...",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    blurb: "Text-only escalation for transaction parsing and match assist.",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "Text-only escalation for transaction parsing and match assist.",
    keyPlaceholder: "sk-...",
  },
  {
    id: "openai_compatible",
    name: "OpenAI-compatible endpoint",
    blurb: "Self-hosted or gateway model (vLLM, Ollama, OpenRouter). Requires a base URL.",
    needsBaseUrl: true,
    keyPlaceholder: "token or sk-...",
  },
];

const AI_TASK_TITLES: Record<string, string> = {
  receipt_ocr: "Receipt OCR",
  bill_ocr: "Bill OCR",
  statement_ocr: "Statement OCR",
  bbox_scan: "Document region scan",
  email_extraction: "Email attachment extraction",
  date_parse: "Date parsing",
  classify_document: "Document classification",
  ingest_triage: "Inbox triage",
  transaction_parse: "Transaction parsing",
  txn_prefill: "Transaction prefill",
  match_assist: "Match assist",
};

const AUTONOMY_KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  document_type: {
    title: "Document type labels",
    blurb:
      "Sets an uploaded document's type (invoice, receipt, statement…) when it is still unlabelled.",
  },
  category_mapping: {
    title: "Category mapping defaults",
    blurb: "Points expense/income categories at chart-of-accounts targets for posting defaults.",
  },
};

const WALLED_KIND_LABELS: Record<string, string> = {
  match: "Transaction matching",
  split: "Splits",
  coa_accounts: "Chart of accounts changes",
  create_party: "Creating vendors/customers",
  date_fix: "Date fixes",
  categorize: "Recategorisation",
};

const PROVIDER_SHORT: Record<string, string> = {
  gemini: "Gemini",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openai_compatible: "Compatible",
};

function formatMaybeDate(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString();
}

function OtherProvidersSection({ orgId, queryClient }: { orgId: string; queryClient: any }) {
  const [provider, setProvider] = useState<AiProviderId>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState("");

  const { data: credentials = [] } = useQuery({
    queryKey: ["org-ai-credentials", orgId],
    queryFn: () =>
      (getOrgAiCredentials as (opts: { data: unknown }) => Promise<OrgAiCredentialView[]>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["org-ai-credentials", orgId] });
    queryClient.invalidateQueries({ queryKey: ["org-ai-settings", orgId] });
  };

  const addMutation = useMutation({
    mutationFn: (args: {
      provider: AiProviderId;
      apiKey: string;
      label?: string;
      baseUrl?: string;
    }) =>
      (addOrgAiCredential as (opts: { data: unknown }) => Promise<unknown>)({
        data: { organizationId: orgId, ...args },
      }),
    onSuccess: () => {
      setApiKey("");
      setLabel("");
      setBaseUrl("");
      setError("");
      invalidate();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to add credential.");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (credentialId: string) =>
      (revokeOrgAiCredential as (opts: { data: unknown }) => Promise<unknown>)({
        data: { organizationId: orgId, credentialId },
      }),
    onSuccess: invalidate,
  });

  const meta = AI_PROVIDER_META.find((p) => p.id === provider)!;

  const submit = () => {
    if (!apiKey.trim()) {
      setError("An API key is required.");
      return;
    }
    if (meta.needsBaseUrl && !baseUrl.trim()) {
      setError("A base URL is required for an OpenAI-compatible endpoint.");
      return;
    }
    addMutation.mutate({
      provider,
      apiKey: apiKey.trim(),
      label: label.trim() || undefined,
      baseUrl: meta.needsBaseUrl ? baseUrl.trim() : undefined,
    });
  };

  return (
    <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
          Other AI Providers
        </h3>
        <p className="text-xs text-[#64748b] dark:text-white/50">
          Optional fallbacks for text-only tasks. Keys are encrypted at rest and are never shown
          again after they are saved.
        </p>
      </div>

      {AI_PROVIDER_META.map((p) => {
        const rows = credentials.filter((c) => c.provider === p.id);
        return (
          <div
            key={p.id}
            className="px-4 py-3.5 rounded-xl bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/5 space-y-2.5"
          >
            <div>
              <p className="text-sm font-medium text-[#1e293b] dark:text-white">{p.name}</p>
              <p className="text-[11px] text-[#94a3b8] dark:text-white/40">{p.blurb}</p>
            </div>

            {rows.length === 0 ? (
              <p className="text-xs text-[#94a3b8] dark:text-white/30">
                No credentials configured.
              </p>
            ) : (
              <div className="space-y-1.5">
                {rows.map((row) => {
                  const lastUsed = formatMaybeDate(row.lastUsedAt);
                  return (
                    <div
                      key={row.id}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] ${
                        row.revokedAt ? "opacity-50" : ""
                      }`}
                    >
                      <span className="font-mono text-xs text-[#64748b] dark:text-white/50">
                        {row.mask}
                      </span>
                      {row.label && (
                        <span className="text-[11px] text-[#64748b] dark:text-white/40 truncate">
                          {row.label}
                        </span>
                      )}
                      {row.baseUrl && (
                        <span className="text-[11px] font-mono text-[#94a3b8] dark:text-white/30 truncate">
                          {row.baseUrl}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-2 shrink-0">
                        {lastUsed && (
                          <span className="text-[10px] text-[#94a3b8] dark:text-white/30">
                            used {lastUsed}
                          </span>
                        )}
                        {row.legacy && (
                          <span className="text-[10px] font-medium text-[#64748b] dark:text-white/40 bg-[#e2e8f0] dark:bg-white/10 px-2 py-0.5 rounded-full">
                            Legacy
                          </span>
                        )}
                        {row.revokedAt ? (
                          <span className="text-[10px] font-medium text-[#ef4444] dark:text-red-400 bg-[#fef2f2] dark:bg-red-900/20 px-2 py-0.5 rounded-full">
                            Revoked
                          </span>
                        ) : row.legacy ? (
                          <span className="text-[10px] text-[#94a3b8] dark:text-white/30">
                            Edit above
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => revokeMutation.mutate(row.id)}
                            disabled={revokeMutation.isPending}
                            className="text-[11px] font-medium text-[#ef4444] hover:underline disabled:opacity-40"
                          >
                            Revoke
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Add credential */}
      <div className="pt-1 space-y-3">
        <label className="block text-xs font-medium text-[#64748b] dark:text-white/50">
          Add a credential
        </label>
        <div className="flex flex-col md:flex-row gap-3">
          <select
            id="ai-credential-provider"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as AiProviderId);
              setError("");
            }}
            className="md:w-56 px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          >
            {AI_PROVIDER_META.filter((p) => p.id !== "gemini").map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={meta.keyPlaceholder}
            className="flex-1 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] font-mono focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          />
        </div>
        <div className="flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="md:w-56 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          />
          {meta.needsBaseUrl && (
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://my-gateway.example.com/v1"
              className="flex-1 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] font-mono focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
            />
          )}
          <button
            type="button"
            onClick={submit}
            disabled={addMutation.isPending}
            className="px-5 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
          >
            Add credential
          </button>
        </div>
        {error && <p className="text-xs text-[#ef4444] dark:text-red-400 font-medium">{error}</p>}
      </div>
    </section>
  );
}

function AiGovernanceSection({ orgId, queryClient }: { orgId: string; queryClient: any }) {
  const [spendCap, setSpendCap] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const { data: config } = useQuery({
    queryKey: ["org-ai-settings", orgId],
    queryFn: () =>
      (getOrgAiSettingsForUi as (opts: { data: unknown }) => Promise<OrgAiConfigView>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  useEffect(() => {
    if (config) {
      setSpendCap(config.monthlySpendCapUsd == null ? "" : String(config.monthlySpendCapUsd));
    }
  }, [config]);

  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      (updateOrgAiSettings as (opts: { data: unknown }) => Promise<unknown>)({
        data: { organizationId: orgId, ...patch },
      }),
    onSuccess: () => {
      setError("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      queryClient.invalidateQueries({ queryKey: ["org-ai-settings", orgId] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to save AI settings.");
    },
  });

  if (!config) return null;

  // Absent allowlist ⇒ Gemini only, so an unchecked box really is "not allowed".
  const allowed = new Set<string>(config.providerAllowlist ?? ["gemini"]);

  const toggleProvider = (id: AiProviderId) => {
    if (id === "gemini") return; // Gemini is required for document/OCR work.
    const next = new Set(allowed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    mutation.mutate({ providerAllowlist: [...next] });
  };

  const toggleKillSwitch = () => {
    const next = !config.killSwitch;
    const message = next
      ? "Turn the AI kill switch ON? This disables all AI features for this organization — OCR, parsing, classification and match assist will stop running until it is turned off."
      : "Turn the AI kill switch OFF? AI features will start running again for this organization.";
    if (!window.confirm(message)) return;
    mutation.mutate({ killSwitch: next });
  };

  const toggleAutonomy = (kind: string, enable: boolean) => {
    if (enable) {
      const meta = AUTONOMY_KIND_TITLES[kind];
      const message = `Let AI apply its own high-confidence "${meta?.title ?? kind}" suggestions without waiting for approval? Every auto-applied change is still recorded and reversible, and this turns itself back off if quality slips.`;
      if (!window.confirm(message)) return;
    }
    const next: Record<string, string> = { ...config.autonomy };
    if (enable) next[kind] = "auto_apply_high_confidence";
    else delete next[kind];
    mutation.mutate({ autonomy: next });
  };

  const saveSpendCap = () => {
    const trimmed = spendCap.trim();
    if (trimmed && !(Number(trimmed) >= 0)) {
      setError("Monthly spend cap must be a positive number.");
      return;
    }
    mutation.mutate({ monthlySpendCapUsd: trimmed === "" ? null : Number(trimmed) });
  };

  return (
    <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
          AI Providers &amp; Guardrails
        </h3>
        <p className="text-xs text-[#64748b] dark:text-white/50">
          Control which providers this organization may send data to, and how much it may spend.
        </p>
      </div>

      {/* Provider allowlist */}
      <div className="space-y-2.5">
        <div>
          <p className="text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
            Allowed providers
          </p>
          <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
            Enabling a provider allows text prompts — transaction descriptions, party names, dates —
            to be sent to it. Document and OCR tasks always stay on Gemini: document images cannot
            be redacted before they are sent, so they are never routed to another vendor.
          </p>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {AI_PROVIDER_META.map((p) => {
            const checked = allowed.has(p.id);
            const locked = p.id === "gemini";
            return (
              <label
                key={p.id}
                className={`flex items-start gap-2.5 px-4 py-3 rounded-xl bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/5 ${
                  locked ? "opacity-70" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={locked || checked}
                  disabled={locked || mutation.isPending}
                  onChange={() => toggleProvider(p.id)}
                  className="mt-0.5 h-4 w-4 rounded border-[#cbd5e1] text-[#0d9488] focus:ring-[#0d9488]/30"
                />
                <span>
                  <span className="block text-sm font-medium text-[#1e293b] dark:text-white">
                    {p.name}
                    {locked && (
                      <span className="ml-2 text-[10px] font-medium text-[#0d9488] dark:text-teal-400">
                        required
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-[#94a3b8] dark:text-white/40">
                    {locked ? "Always enabled — document and OCR tasks run here." : p.blurb}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Effective chains — read only */}
      <div className="space-y-2">
        <div>
          <p className="text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">
            What runs for each task
          </p>
          <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
            Models are tried in order; the first one that returns valid output wins. A greyed hop is
            not allowed by the settings above and will be skipped.
          </p>
        </div>
        <div className="space-y-1.5">
          {config.effectiveChains.map((chain) => (
            <div
              key={chain.task}
              className="flex flex-col md:flex-row md:items-center gap-2 px-4 py-2.5 rounded-lg bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/5"
            >
              <span className="text-xs font-medium text-[#1e293b] dark:text-white md:w-52 shrink-0">
                {AI_TASK_TITLES[chain.task] ?? chain.task}
                {chain.documentTask && (
                  <span className="ml-1.5 text-[10px] font-normal text-[#0d9488] dark:text-teal-400">
                    Gemini-only
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {chain.hops.map((hop, i) => (
                  <span
                    key={`${hop.provider}-${hop.model}-${i}`}
                    className={`font-mono text-[11px] px-2 py-0.5 rounded-full border ${
                      hop.allowed
                        ? "text-[#0d9488] dark:text-teal-300 bg-[#0d9488]/10 dark:bg-teal-900/30 border-transparent"
                        : "text-[#94a3b8] dark:text-white/30 border-[#e2e8f0] dark:border-white/10 line-through"
                    }`}
                  >
                    {PROVIDER_SHORT[hop.provider] ?? hop.provider} · {hop.model}
                  </span>
                ))}
                {chain.source === "override" && (
                  <span className="text-[10px] text-[#94a3b8] dark:text-white/30">custom</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Earned automation (per-kind auto-apply) */}
      <div className="space-y-2">
        <div>
          <p className="text-xs font-medium text-[#64748b] dark:text-white/50 mb-1">Automation</p>
          <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
            A task can apply its own high-confidence suggestions only after this organization has
            reviewed 200+ of them with a 98%+ acceptance rate — and it turns itself back off if
            quality slips. Everything auto-applied stays visible and reversible.
          </p>
        </div>
        <div className="space-y-1.5">
          {(config.autonomyKinds ?? []).map((k) => {
            const meta = AUTONOMY_KIND_TITLES[k.kind] ?? { title: k.kind, blurb: "" };
            const canEnable = k.eligibility.eligible;
            const pct = (k.eligibility.acceptanceRate * 100).toFixed(1);
            return (
              <div
                key={k.kind}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#1e293b] dark:text-white">
                    {meta.title}
                    {k.enabled && (
                      <span className="ml-2 text-[10px] font-medium text-[#0d9488] dark:text-teal-400">
                        auto-applying
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-[#94a3b8] dark:text-white/40">{meta.blurb}</p>
                  <p className="text-[11px] mt-0.5 text-[#64748b] dark:text-white/50">
                    {k.eligibility.total > 0
                      ? `${k.eligibility.total} reviewed · ${pct}% accepted — `
                      : ""}
                    {k.enabled
                      ? "On: suggestions at or above the confidence threshold apply themselves."
                      : k.eligibility.reason}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleAutonomy(k.kind, !k.enabled)}
                  disabled={mutation.isPending || (!k.enabled && !canEnable)}
                  className={`touch-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 disabled:opacity-40 ${
                    k.enabled ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/10"
                  }`}
                  aria-label={`Toggle auto-apply for ${meta.title}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                      k.enabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            );
          })}
          <div className="px-4 py-3 rounded-xl bg-[#f8fafc] dark:bg-[#0f172a] border border-dashed border-[#e2e8f0] dark:border-white/10">
            <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
              Always applied by a human, at any accuracy:{" "}
              {(config.walledKinds ?? [])
                .map((kind) => WALLED_KIND_LABELS[kind] ?? kind)
                .join(", ")}
              . These change money movement, the chart, or counterparties — AI only suggests.
            </p>
          </div>
        </div>
      </div>

      {/* Monthly spend cap */}
      <div>
        <label
          htmlFor="ai-spend-cap"
          className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5"
        >
          Monthly spend cap (USD, optional)
        </label>
        <div className="flex gap-3">
          <input
            id="ai-spend-cap"
            type="number"
            min="0"
            step="1"
            value={spendCap}
            onChange={(e) => setSpendCap(e.target.value)}
            placeholder="No cap"
            className="md:w-56 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          />
          <button
            type="button"
            onClick={saveSpendCap}
            disabled={mutation.isPending}
            className="px-5 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
          >
            Save
          </button>
        </div>
      </div>

      {/* Kill switch */}
      <div className="flex items-center justify-between px-4 py-3.5 rounded-xl bg-[#fef2f2] dark:bg-red-900/10 border border-[#fecaca] dark:border-red-900/30">
        <div className="pr-4">
          <p className="text-sm font-medium text-[#b91c1c] dark:text-red-300">AI kill switch</p>
          <p className="text-[11px] text-[#b91c1c]/80 dark:text-red-300/70">
            Disables all AI features for this organization. OCR, parsing, classification and match
            assist stop running immediately; nothing else is affected.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleKillSwitch}
          disabled={mutation.isPending}
          className={`touch-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#ef4444]/30 ${
            config.killSwitch ? "bg-[#ef4444]" : "bg-[#e2e8f0] dark:bg-white/10"
          }`}
          aria-label="Toggle AI kill switch"
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              config.killSwitch ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      {saved && (
        <div className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
          ✓ AI settings saved
        </div>
      )}
      {error && <div className="text-xs text-[#ef4444] dark:text-red-400 font-medium">{error}</div>}
    </section>
  );
}

// ============================================================================
// Members Section
// ============================================================================

function MembersSection({
  members,
  orgId,
  queryClient,
  currentUserId,
}: {
  members: OrgMember[];
  orgId: string;
  queryClient: any;
  currentUserId?: string;
}) {
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [copiedId, setCopiedId] = useState("");

  // Fetch invitations
  const { data: invitations = [] } = useQuery({
    queryKey: ["org-invitations", orgId],
    queryFn: () =>
      (listInvitations as (opts: { data: unknown }) => Promise<OrgInvitation[]>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  const roleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      (updateMemberRole as (opts: { data: unknown }) => Promise<unknown>)({
        data: { memberId, role },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["org-members"] }),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      (removeOrgMember as (opts: { data: unknown }) => Promise<unknown>)({
        data: { memberId },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["org-members"] }),
  });

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; role: string }) =>
      (createInvitation as (opts: { data: unknown }) => Promise<any>)({
        data: { email: data.email, role: data.role },
      }),
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ["org-invitations"] });
      const inviteId = result?.invitationId ?? result?.id ?? "";
      const joinUrl = `${window.location.origin}/organizations/join?code=${inviteId}`;
      setInviteSuccess(joinUrl);
      setInviteEmail("");
    },
  });

  const handleInvite = () => {
    if (!inviteEmail.trim()) return;
    inviteMutation.mutate({ email: inviteEmail.trim(), role: inviteRole });
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(""), 2000);
  };

  const roleColors: Record<string, string> = {
    owner:
      "bg-[#fef3c7] dark:bg-amber-900/20 text-[#92400e] dark:text-amber-300 border-[#fde68a] dark:border-amber-700/40",
    admin:
      "bg-[#dbeafe] dark:bg-blue-900/20 text-[#1e40af] dark:text-blue-300 border-[#93c5fd] dark:border-blue-700/40",
    member:
      "bg-[#f1f5f9] dark:bg-white/5 text-[#64748b] dark:text-white/50 border-[#e2e8f0] dark:border-white/10",
    report_viewer:
      "bg-[#ecfeff] dark:bg-cyan-900/20 text-[#155e75] dark:text-cyan-300 border-[#a5f3fc] dark:border-cyan-700/40",
  };

  const statusColors: Record<string, string> = {
    pending: "bg-[#fef3c7] dark:bg-amber-900/20 text-[#92400e] dark:text-amber-300",
    accepted: "bg-[#dcfce7] dark:bg-green-900/20 text-[#166534] dark:text-green-300",
    canceled: "bg-[#f1f5f9] dark:bg-white/5 text-[#64748b] dark:text-white/50",
    rejected: "bg-[#fef2f2] dark:bg-red-900/20 text-[#991b1b] dark:text-red-300",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">Members</h2>
          <p className="text-sm text-[#64748b] dark:text-white/50">
            Manage who has access to this organization.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowInviteModal(true);
            setInviteSuccess("");
            setInviteEmail("");
          }}
          className="px-4 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] text-white text-sm font-medium transition-all flex items-center gap-2"
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
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Invite Member
        </button>
      </div>
      {/* Invite Modal */}
      {showInviteModal &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9999,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Backdrop */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(0,0,0,0.4)",
                backdropFilter: "blur(4px)",
              }}
              onClick={() => setShowInviteModal(false)}
            />

            {/* Modal */}
            <div
              style={{
                position: "relative",
                width: "100%",
                maxWidth: 448,
                margin: "0 16px",
                borderRadius: 16,
                overflow: "hidden",
                boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
              }}
              className="bg-white dark:bg-[#1e293b] border border-[#e2e8f0] dark:border-white/10"
            >
              <div className="p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-lg font-semibold text-[#1e293b] dark:text-white">
                    Invite Member
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowInviteModal(false)}
                    className="touch-target w-8 h-8 flex items-center justify-center rounded-lg text-[#94a3b8] hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
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
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>

                {inviteSuccess ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-[#0d9488] dark:text-teal-400 mt-0.5 shrink-0"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <p className="text-xs text-[#0d9488] dark:text-teal-300">
                        Invitation sent! The user will receive an email with a link to join.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                        Invite Link
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          readOnly
                          value={inviteSuccess}
                          className="flex-1 px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a] text-base sm:text-xs text-[#64748b] dark:text-white/50 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => copyToClipboard(inviteSuccess, "invite-link")}
                          className="px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-xs font-medium text-[#0d9488] hover:bg-[#f0fdfa] dark:hover:bg-teal-900/20 transition-colors"
                        >
                          {copiedId === "invite-link" ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setInviteSuccess("");
                          setInviteEmail("");
                        }}
                        className="px-4 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] text-white text-sm font-medium transition-all"
                      >
                        Invite Another
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowInviteModal(false)}
                        className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#64748b] hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                        Email Address
                      </label>
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                        placeholder="colleague@company.com"
                        className="w-full px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
                        autoFocus
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                        Role
                      </label>
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                        className="w-full px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
                      >
                        <option value="member">Member</option>
                        <option value="report_viewer">Report viewer</option>
                      </select>
                    </div>

                    {inviteMutation.isError && (
                      <div className="text-xs text-[#ef4444] dark:text-red-400 font-medium">
                        {(inviteMutation.error as Error)?.message ||
                          "Failed to send invitation. Please try again."}
                      </div>
                    )}

                    <div className="flex justify-end gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setShowInviteModal(false)}
                        className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#64748b] hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleInvite}
                        disabled={!inviteEmail.trim() || inviteMutation.isPending}
                        className="px-5 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
                      >
                        {inviteMutation.isPending ? "Sending…" : "Send Invitation"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Current Members */}
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden mb-6">
        {/* Header */}
        <div className="px-6 py-3 border-b border-[#e2e8f0] dark:border-white/10 flex items-center justify-between">
          <span className="text-xs font-medium text-[#64748b] dark:text-white/50 uppercase tracking-wider">
            {members.length} member{members.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Member list */}
        <div className="divide-y divide-[#e2e8f0] dark:divide-white/10 max-h-[400px] overflow-y-auto">
          {members.map((m) => (
            <div
              key={m.id}
              className="px-6 py-4 flex items-center gap-4 group hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] transition-colors"
            >
              {/* Avatar */}
              {m.user.image ? (
                <img
                  src={m.user.image}
                  alt=""
                  className="w-9 h-9 rounded-full object-cover shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#0d9488] to-[#0f766e] flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {(m.user.name?.charAt(0) || m.user.email?.charAt(0) || "?").toUpperCase()}
                </div>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                  {m.user.name}
                  {m.userId === currentUserId && (
                    <span className="ml-1.5 text-[10px] text-[#94a3b8] dark:text-white/30">
                      (you)
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#94a3b8] dark:text-white/40 truncate">
                  {m.user.email}
                </div>
              </div>

              {/* Role badge */}
              <select
                value={m.role}
                onChange={(e) => roleMutation.mutate({ memberId: m.id, role: e.target.value })}
                disabled={m.userId === currentUserId || m.role === "owner"}
                className={`text-base sm:text-xs font-medium px-2.5 py-1 rounded-full border appearance-none cursor-pointer disabled:cursor-default disabled:opacity-60 ${roleColors[m.role] || roleColors.member}`}
              >
                <option value="owner">Owner</option>
                <option value="member">Member</option>
                <option value="report_viewer">Report viewer</option>
              </select>

              {/* Remove */}
              {m.userId !== currentUserId && m.role !== "owner" && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Remove ${m.user.name} from this organization?`)) {
                      removeMutation.mutate(m.id);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-lg text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-all"
                  title="Remove member"
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
            </div>
          ))}
        </div>
      </section>

      {/* Pending Invitations */}
      {(() => {
        const pendingInvitations = invitations.filter((inv) => inv.status === "pending");
        if (pendingInvitations.length === 0) return null;
        return (
          <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden">
            <div className="px-6 py-3 border-b border-[#e2e8f0] dark:border-white/10">
              <span className="text-xs font-medium text-[#64748b] dark:text-white/50 uppercase tracking-wider">
                Pending Invitations ({pendingInvitations.length})
              </span>
            </div>
            <div className="divide-y divide-[#e2e8f0] dark:divide-white/10 max-h-[300px] overflow-y-auto">
              {pendingInvitations.map((inv) => (
                <div
                  key={inv.id}
                  className="px-6 py-4 flex items-center gap-4 group hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] transition-colors"
                >
                  <div className="w-9 h-9 rounded-full bg-[#f1f5f9] dark:bg-white/5 flex items-center justify-center text-[#94a3b8] dark:text-white/40 text-xs font-bold shrink-0">
                    {inv.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                      {inv.email}
                    </div>
                    <div className="text-xs text-[#94a3b8] dark:text-white/40">
                      Invited {new Date(inv.createdAt).toLocaleDateString()}
                      {inv.expiresAt &&
                        ` · Expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${statusColors[inv.status] || statusColors.pending}`}
                  >
                    {inv.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const url = `${window.location.origin}/organizations/join?code=${inv.id}`;
                      copyToClipboard(url, inv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-xs text-[#0d9488] hover:text-[#0f766e] dark:text-teal-400 font-medium transition-all"
                  >
                    {copiedId === inv.id ? "Copied!" : "Copy link"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        );
      })()}
    </div>
  );
}

// ============================================================================
// Skeleton
function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="w-48 h-7 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse" />
      <div className="w-72 h-4 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse" />
      <div className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6">
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i}>
              <div className="w-20 h-3 bg-[#e2e8f0] dark:bg-white/10 rounded animate-pulse mb-2" />
              <div className="w-full h-10 bg-[#e2e8f0] dark:bg-white/10 rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
