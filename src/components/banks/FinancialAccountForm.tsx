/**
 * FinancialAccountForm — Create/Edit form for financial accounts
 * Ledger assignment comes from the server-side bank category mapping.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import {
  createFinancialAccount,
  updateFinancialAccount,
  uploadFinancialAccountAvatar,
  setFinancialAccountStatementPassword,
} from "../../routes/api/-financial-accounts";
import { getAccountsByType } from "../../routes/api/-accounts";
import { getMappedAccounts } from "../../routes/api/-category-mappings";
import { keys as queryKeys } from "../../lib/query-keys";

interface LedgerAccount {
  id: string;
  name: string;
  accountNumber: string | null;
  accountType: string;
  subtype: string | null;
}

interface FormData {
  accountName: string;
  institutionName: string;
  institutionLogoUrl: string;
  accountType: string;
  lastFour: string;
  ledgerAccountId: string;
  isOwned: boolean;
}

interface FinancialAccountFormProps {
  initialData?: {
    id: string;
    accountName: string;
    institutionName?: string | null;
    institutionLogoUrl?: string | null;
    accountType: string;
    lastFour?: string | null;
    ledgerAccountId?: string | null;
    isOwned?: boolean | null;
    statementPasswordSet?: boolean | null;
  };
  onClose: () => void;
}

const ACCOUNT_TYPES = [
  { value: "checking", label: "Checking", icon: "🏦" },
  { value: "savings", label: "Savings", icon: "🏦" },
  { value: "credit_card", label: "Credit Card", icon: "💳" },
  { value: "money_market", label: "Money Market", icon: "🏦" },
  { value: "investment", label: "Investment", icon: "📈" },
  { value: "other", label: "Other", icon: "🏛️" },
];

/** Map from financial account type → ledger account type */
const LEDGER_TYPE_FOR: Record<string, "asset" | "liability"> = {
  checking: "asset",
  savings: "asset",
  money_market: "asset",
  investment: "asset",
  other: "asset",
  credit_card: "liability",
};

export function FinancialAccountForm({ initialData, onClose }: FinancialAccountFormProps) {
  const queryClient = useQueryClient();
  const isEdit = !!initialData;

  const [form, setForm] = useState<FormData>({
    accountName: initialData?.accountName || "",
    institutionName: initialData?.institutionName || "",
    institutionLogoUrl: initialData?.institutionLogoUrl || "",
    accountType: initialData?.accountType || "checking",
    lastFour: initialData?.lastFour || "",
    ledgerAccountId: initialData?.ledgerAccountId || "",
    isOwned: initialData?.isOwned ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Statement PDF password (a server-only secret, saved separately from the
  // account fields). `hasStoredPassword` reflects what's already stored.
  const [hasStoredPassword, setHasStoredPassword] = useState<boolean>(
    initialData?.statementPasswordSet ?? false,
  );
  const [statementPassword, setStatementPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [replacingPassword, setReplacingPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);

  // Reset form when initialData changes
  useEffect(() => {
    if (initialData) {
      setForm({
        accountName: initialData.accountName || "",
        institutionName: initialData.institutionName || "",
        institutionLogoUrl: initialData.institutionLogoUrl || "",
        accountType: initialData.accountType || "checking",
        lastFour: initialData.lastFour || "",
        ledgerAccountId: initialData.ledgerAccountId || "",
        isOwned: initialData.isOwned ?? false,
      });
      setHasStoredPassword(initialData.statementPasswordSet ?? false);
      setStatementPassword("");
      setReplacingPassword(false);
      setClearPassword(false);
      setShowPassword(false);
    }
  }, [initialData]);

  // Determine ledger account type from financial account type
  const ledgerType = LEDGER_TYPE_FOR[form.accountType] || "asset";

  // Fetch ledger accounts filtered by type
  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["accounts-by-type", ledgerType],
    queryFn: () =>
      (getAccountsByType as (opts: { data: unknown }) => Promise<LedgerAccount[]>)({
        data: { accountType: ledgerType },
      }),
    staleTime: 60_000,
  });

  // Auto-assign from the SERVER-side bank mapping. This previously called
  // `resolveCategory`, which read localStorage — so the Banks tab in Settings
  // wrote to the database while this form read a completely different store,
  // and editing the mapping had no effect on what a new account was assigned.
  const { data: mappedBankAccounts } = useQuery<Record<string, string | null>>({
    queryKey: queryKeys.categoryMappings.resolved("bank", [form.accountType]),
    queryFn: () =>
      (getMappedAccounts as (opts: { data: unknown }) => Promise<Record<string, string | null>>)({
        data: { mappingType: "bank", sourceKeys: [form.accountType] },
      }),
    staleTime: 60_000,
  });
  const autoAssignedId = mappedBankAccounts?.[form.accountType] ?? "";

  // Auto-assign when type changes (only for new accounts)
  useEffect(() => {
    if (autoAssignedId && !isEdit) {
      setForm((prev) => ({ ...prev, ledgerAccountId: autoAssignedId }));
    }
  }, [autoAssignedId, isEdit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.accountName.trim()) {
      setError("Account name is required");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        accountName: form.accountName.trim(),
        institutionName: form.institutionName.trim() || undefined,
        institutionLogoUrl: form.institutionLogoUrl.trim() || undefined,
        accountType: form.accountType,
        lastFour: form.lastFour.trim() || undefined,
        ledgerAccountId: form.ledgerAccountId || null,
        isOwned: form.isOwned,
      };

      let accountId = initialData?.id;
      if (isEdit && initialData) {
        await (updateFinancialAccount as (opts: { data: unknown }) => Promise<any>)({
          data: { id: initialData.id, ...payload },
        });
      } else {
        const created = await (createFinancialAccount as (opts: { data: unknown }) => Promise<any>)(
          { data: payload },
        );
        accountId = created?.id;
      }

      // Persist the statement password separately (server-only secret).
      if (accountId) {
        const newPassword = statementPassword.trim();
        if (newPassword) {
          await (setFinancialAccountStatementPassword as (opts: { data: unknown }) => Promise<any>)(
            { data: { id: accountId, password: newPassword } },
          );
        } else if (clearPassword && hasStoredPassword) {
          await (setFinancialAccountStatementPassword as (opts: { data: unknown }) => Promise<any>)(
            { data: { id: accountId, password: null } },
          );
        }
      }

      queryClient.invalidateQueries({ queryKey: ["financial-accounts"] });
      onClose();
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setError(errMessage || "Failed to save account");
      setSaving(false);
    }
  };

  const setField = (key: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
        {/* Header with action buttons */}
        <div className="flex items-center justify-between px-8 h-[77px] border-b border-[#e2e8f0] dark:border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white">
              {isEdit ? "Edit Account" : "New Account"}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-9 min-h-11 lg:min-h-0 px-4 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/60 hover:bg-[#f1f5f9] dark:hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 h-9 min-h-11 lg:min-h-0 px-5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
            >
              {saving ? (
                <>
                  <span className="animate-spin w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" />
                  Saving…
                </>
              ) : isEdit ? (
                "Save Changes"
              ) : (
                "Create Account"
              )}
            </button>
          </div>
        </div>

        {/* Form Body */}
        <div className="px-8 py-6 space-y-5 flex-1 overflow-y-auto">
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Institution Logo Upload */}
          <div className="flex flex-col items-center mb-1">
            <div className="relative group">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-20 h-20 rounded-full overflow-hidden border-2 border-dashed border-[#e2e8f0] dark:border-white/15 hover:border-[#10b981] dark:hover:border-[#10b981] transition-colors cursor-pointer flex items-center justify-center relative"
                title="Upload institution logo"
              >
                {uploading ? (
                  <div className="w-6 h-6 border-2 border-[#10b981] border-t-transparent rounded-full animate-spin" />
                ) : form.institutionLogoUrl ? (
                  <img
                    src={form.institutionLogoUrl}
                    alt="Logo"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#10b981] to-[#059669] text-white font-bold text-lg">
                    {(form.accountName || form.institutionName || "?")
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")
                      .toUpperCase()}
                  </div>
                )}
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
              {form.institutionLogoUrl && !uploading && (
                <button
                  type="button"
                  onClick={() => {
                    setField("institutionLogoUrl", "");
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-600 shadow-sm transition-colors"
                  title="Remove logo"
                >
                  ×
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!isEdit || !initialData) {
                  const reader = new FileReader();
                  reader.onload = () => setField("institutionLogoUrl", reader.result as string);
                  reader.readAsDataURL(file);
                  return;
                }
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
                  const result = await (
                    uploadFinancialAccountAvatar as (opts: { data: any }) => Promise<any>
                  )({
                    data: {
                      accountId: initialData.id,
                      filename: file.name,
                      contentType: file.type,
                      fileBase64: base64,
                    },
                  });
                  setField("institutionLogoUrl", result.institutionLogoUrl);
                  queryClient.invalidateQueries({ queryKey: ["financial-accounts"] });
                } catch (err: unknown) {
                  const errMessage = err instanceof Error ? err.message : String(err);
                  setError(errMessage ?? "Logo upload failed");
                } finally {
                  setUploading(false);
                }
              }}
              className="hidden"
            />
            <span className="text-[10px] text-[#94a3b8] dark:text-white/40 mt-1.5">
              Click to upload logo
            </span>
          </div>

          {/* Account Name */}
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Account Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.accountName}
              onChange={(e) => setField("accountName", e.target.value)}
              placeholder="e.g. Mercury Checking"
              className="w-full px-3 py-2.5 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
              autoFocus
            />
          </div>

          {/* Institution Name */}
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Institution
            </label>
            <input
              type="text"
              value={form.institutionName}
              onChange={(e) => setField("institutionName", e.target.value)}
              placeholder="e.g. Mercury, Chase, Wells Fargo"
              className="w-full px-3 py-2.5 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
            />
          </div>

          {/* Account Type */}
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Account Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {ACCOUNT_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setField("accountType", t.value)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border transition-all ${
                    form.accountType === t.value
                      ? "border-[#10b981]/40 bg-[#10b981]/5 dark:bg-[#10b981]/10 text-[#10b981] dark:text-[#34d399] ring-1 ring-[#10b981]/20"
                      : "border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/50 hover:border-[#cbd5e1] dark:hover:border-white/15"
                  }`}
                >
                  <span>{t.icon}</span>
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Last Four Digits */}
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Last Four Digits
            </label>
            <input
              type="text"
              value={form.lastFour}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                setField("lastFour", val);
              }}
              placeholder="1234"
              maxLength={4}
              className="w-32 px-3 py-2.5 rounded-lg text-base sm:text-sm font-mono bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors tracking-widest"
            />
          </div>

          {/* Statement PDF Password */}
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Statement PDF Password
            </label>
            {hasStoredPassword && !replacingPassword && !clearPassword ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm text-[#1e293b] dark:text-white">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Password is set
                </span>
                <button
                  type="button"
                  onClick={() => setReplacingPassword(true)}
                  className="text-xs font-medium text-[#0d9488] hover:underline"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={() => setClearPassword(true)}
                  className="text-xs font-medium text-red-500 hover:underline"
                >
                  Remove
                </button>
              </div>
            ) : clearPassword ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-red-500">Password will be removed on save</span>
                <button
                  type="button"
                  onClick={() => setClearPassword(false)}
                  className="text-xs font-medium text-[#0d9488] hover:underline"
                >
                  Undo
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type={showPassword ? "text" : "password"}
                  value={statementPassword}
                  onChange={(e) => setStatementPassword(e.target.value)}
                  placeholder="Password to unlock protected statements"
                  autoComplete="off"
                  className="flex-1 px-3 py-2.5 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="text-xs font-medium text-[#64748b] dark:text-white/50 hover:underline"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-[#94a3b8] dark:text-white/40">
              Used to automatically unlock password-protected statement PDFs you upload or email in.
              Stored encrypted.
            </p>
          </div>

          {/* Linked Ledger Account */}
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Ledger Category
              <span className="ml-1 text-[#94a3b8] dark:text-white/30 normal-case tracking-normal font-normal">
                ({ledgerType === "liability" ? "Liability" : "Asset"})
              </span>
            </label>
            {form.ledgerAccountId && !isEdit && (
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  Auto-assigned from settings
                </span>
              </div>
            )}
            <select
              value={form.ledgerAccountId}
              onChange={(e) => setField("ledgerAccountId", e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-colors"
            >
              <option value="">No linked category</option>
              {ledgerAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber ? `${a.accountNumber} — ` : ""}
                  {a.name}
                  {a.subtype ? ` (${a.subtype.replace(/_/g, " ")})` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Company-owned toggle */}
          <div className="pt-1">
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="mt-0.5">
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, isOwned: !prev.isOwned }))}
                  className={`touch-target relative w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#10b981]/40 ${
                    form.isOwned ? "bg-[#10b981]" : "bg-[#e2e8f0] dark:bg-white/20"
                  }`}
                  aria-checked={form.isOwned}
                  role="switch"
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      form.isOwned ? "translate-x-5" : ""
                    }`}
                  />
                </button>
              </div>
              <div>
                <div className="text-sm font-semibold text-[#1e293b] dark:text-white">
                  Company-owned account
                </div>
                <div className="text-xs text-[#64748b] dark:text-white/40 mt-0.5 leading-relaxed">
                  Enable to show this account in the{" "}
                  <strong className="text-[#10b981]">Connections hub</strong> for wire payment
                  links. Only company accounts should be toggled on.
                </div>
              </div>
            </label>
          </div>
        </div>
      </form>
    </div>
  );
}
