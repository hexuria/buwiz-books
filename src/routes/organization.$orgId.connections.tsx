/**
 * Connections — /organization/$orgId/connections
 * connections hub: My Connections | Banks & Cards | Revenue | Bills & Expenses | Payroll
 * Banks & Cards lets you enable bank accounts for invoice payment display and add wire details.
 * Revenue lets you connect Stripe and PayPal payment gateways.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { listFinancialAccounts, updateFinancialAccount } from "./api/-financial-accounts";
import { getPaymentGatewayConfig, savePaymentGatewayConfig } from "./api/-connections-payments";
import type { PaymentGatewayConfig } from "./api/-connections-payments";
import type { ServerFnResult } from "@/lib/server-fn-client";

export const Route = createFileRoute("/organization/$orgId/connections")({
  component: ConnectionsPage,
});

// ============================================================================
// Types
// ============================================================================

type ConnectionSection = "overview" | "banks" | "revenue" | "bills" | "payroll";

type BankListItem = ServerFnResult<typeof listFinancialAccounts>[number];

const SECTIONS: { key: ConnectionSection; label: string; icon: React.ReactNode }[] = [
  {
    key: "overview",
    label: "My Connections",
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
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    key: "banks",
    label: "Banks & Cards",
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
        <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
        <line x1="1" y1="10" x2="23" y2="10" />
      </svg>
    ),
  },
  {
    key: "revenue",
    label: "Revenue",
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
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
  },
  {
    key: "bills",
    label: "Bills & Expenses",
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
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  {
    key: "payroll",
    label: "Payroll",
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
];

// ============================================================================
// Main Page
// ============================================================================

function ConnectionsPage() {
  const orgId = Route.useParams().orgId;
  const queryClient = useQueryClient();
  const [section, setSection] = useState<ConnectionSection>("overview");

  const { data: allBanks = [], isLoading: banksLoading } = useQuery({
    queryKey: ["financial-accounts", orgId],
    queryFn: () => listFinancialAccounts({ data: {} }),
  });

  // Only show company-owned accounts in the Connections hub
  const banks = allBanks.filter((b) => b.isOwned === true);

  const { data: gatewayConfig, isLoading: gatewayLoading } = useQuery({
    queryKey: ["payment-gateway-config", orgId],
    queryFn: () =>
      (getPaymentGatewayConfig as (opts: { data: unknown }) => Promise<PaymentGatewayConfig>)({
        data: { organizationId: orgId },
      }),
    enabled: !!orgId,
  });

  const stripeConnected =
    !!gatewayConfig?.stripeSecretKeySet &&
    (gatewayConfig.paymentProvider === "stripe" || gatewayConfig.paymentProvider === "both");
  const paypalConnected =
    !!gatewayConfig?.paypalClientId &&
    (gatewayConfig.paymentProvider === "paypal" || gatewayConfig.paymentProvider === "both");
  const enabledBankCount = banks.filter((b) => b.showOnPaymentLink).length;

  const inputClass =
    "w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all font-mono";

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
          <h1 className="ml-6 text-lg font-semibold text-[#1e293b] dark:text-white">Connections</h1>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-8">
        {/* Left sidebar */}
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

        {/* Main content */}
        <main className="flex-1 min-w-0">
          {section === "overview" && (
            <OverviewSection
              stripeConnected={stripeConnected}
              paypalConnected={paypalConnected}
              enabledBankCount={enabledBankCount}
              banks={banks}
              onNavigate={setSection}
            />
          )}
          {section === "banks" && (
            <BanksSection
              banks={banks}
              isLoading={banksLoading}
              orgId={orgId}
              queryClient={queryClient}
              inputClass={inputClass}
            />
          )}
          {section === "revenue" && (
            <RevenueSection
              orgId={orgId}
              config={gatewayConfig}
              isLoading={gatewayLoading}
              queryClient={queryClient}
              inputClass={inputClass}
            />
          )}
          {section === "bills" && <ComingSoonSection title="Bills & Expenses" />}
          {section === "payroll" && <ComingSoonSection title="Payroll" />}
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// Overview Section
// ============================================================================

function OverviewSection({
  stripeConnected,
  paypalConnected,
  enabledBankCount,
  banks,
  onNavigate,
}: {
  stripeConnected: boolean;
  paypalConnected: boolean;
  enabledBankCount: number;
  banks: BankListItem[];
  onNavigate: (s: ConnectionSection) => void;
}) {
  const cards = [
    {
      logo: "💳",
      name: "Stripe",
      desc: "Accept card payments on invoices",
      connected: stripeConnected,
      section: "revenue" as ConnectionSection,
    },
    {
      logo: "🅿️",
      name: "PayPal",
      desc: "Accept PayPal payments on invoices",
      connected: paypalConnected,
      section: "revenue" as ConnectionSection,
    },
  ];

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">My Connections</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        All integrations and connected services for your organization.
      </p>

      {/* Payment gateways */}
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 mb-6">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-4 flex items-center gap-2">
          <span className="text-[#0d9488]">
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
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </span>
          Revenue
        </h3>
        <div className="space-y-3">
          {cards.map((c) => (
            <div
              key={c.name}
              className="flex items-center justify-between p-4 rounded-xl border border-[#e2e8f0] dark:border-white/10"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{c.logo}</span>
                <div>
                  <div className="text-sm font-semibold text-[#1e293b] dark:text-white">
                    {c.name}
                  </div>
                  <div className="text-xs text-[#64748b] dark:text-white/40">{c.desc}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
                    c.connected
                      ? "bg-[#dcfce7] dark:bg-green-900/30 text-[#16a34a] dark:text-green-400"
                      : "bg-[#f1f5f9] dark:bg-white/5 text-[#94a3b8] dark:text-white/30"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${c.connected ? "bg-[#16a34a]" : "bg-[#94a3b8]"}`}
                  />
                  {c.connected ? "Connected" : "Not configured"}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate(c.section)}
                  className="px-3 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-xs font-semibold text-[#64748b] dark:text-white/50 hover:text-[#0d9488] hover:border-[#0d9488] transition-all"
                >
                  {c.connected ? "Manage" : "Connect"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Bank accounts */}
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-4 flex items-center gap-2">
          <span className="text-[#0d9488]">
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
          </span>
          Banks & Cards{" "}
          {enabledBankCount > 0 && (
            <span className="ml-1 text-xs font-normal text-[#0d9488]">
              ({enabledBankCount} enabled for payment links)
            </span>
          )}
        </h3>
        {banks.length === 0 ? (
          <p className="text-sm text-[#94a3b8] dark:text-white/30">
            No company bank accounts found.{" "}
            <Link to="/entities/banks" className="text-[#0d9488] hover:underline no-underline">
              Add in Banks &amp; Cards
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-2">
            {banks.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between p-3 rounded-xl border border-[#e2e8f0] dark:border-white/10"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[#f8fafc] dark:bg-white/5 flex items-center justify-center text-xs font-bold text-[#334155] dark:text-white/60 border border-[#e2e8f0] dark:border-white/10">
                    {b.accountName?.charAt(0)?.toUpperCase() ?? "B"}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-[#1e293b] dark:text-white">
                      {b.accountName}
                    </div>
                    <div className="text-xs text-[#94a3b8] dark:text-white/30">
                      {b.institutionName ?? "Manual"} ·{" "}
                      {b.lastFour ? `••••${b.lastFour}` : "No routing"}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {b.showOnPaymentLink && (
                    <span className="text-xs font-semibold text-[#0d9488] dark:text-teal-400 bg-[#f0fdf4] dark:bg-teal-900/20 px-2 py-0.5 rounded-full">
                      On payment links
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onNavigate("banks")}
                    className="text-xs text-[#64748b] dark:text-white/40 hover:text-[#0d9488] transition-colors"
                  >
                    Configure →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ============================================================================
// Banks Section — wire details + show-on-payment-link toggle
// ============================================================================

function BanksSection({
  banks,
  isLoading,
  orgId: _orgId,
  queryClient,
  inputClass,
}: {
  banks: BankListItem[];
  isLoading: boolean;
  orgId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  inputClass: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      (updateFinancialAccount as (opts: { data: unknown }) => Promise<unknown>)({ data }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["financial-accounts"] });
      setSavedId((vars as Record<string, unknown>).id as string);
      setTimeout(() => setSavedId(null), 2000);
    },
  });

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">
        Our Bank Accounts &amp; Cards
      </h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-1">
        Company-owned accounts for payment collection and reconciliation. Toggle which accounts show
        on invoice payment links for manual wire transfers.
      </p>
      <div className="mb-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#f0f9ff] dark:bg-sky-900/20 border border-[#bae6fd] dark:border-sky-500/20 text-xs text-[#0369a1] dark:text-sky-400">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        These are <strong className="mx-1">your company&apos;s</strong> accounts, not third-party
        banks. To add a new account, go to{" "}
        <Link to="/entities/banks" className="underline font-medium no-underline hover:underline">
          Banks &amp; Cards
        </Link>
        .
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-2xl bg-[#f1f5f9] dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : banks.length === 0 ? (
        <div className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-10 text-center">
          <p className="text-sm text-[#94a3b8] dark:text-white/30 mb-2">
            No company bank accounts found.
          </p>
          <Link
            to="/entities/banks"
            className="inline-flex items-center gap-1.5 text-sm text-[#0d9488] hover:underline no-underline font-medium"
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
            Add a bank account
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {banks.map((bank) => (
            <BankConnectionCard
              key={bank.id}
              bank={bank}
              isExpanded={expandedId === bank.id}
              onToggle={() => setExpandedId(expandedId === bank.id ? null : bank.id)}
              onSave={(fields) => updateMutation.mutate({ id: bank.id, ...fields })}
              isSaving={updateMutation.isPending}
              savedOk={savedId === bank.id}
              inputClass={inputClass}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BankConnectionCard({
  bank,
  isExpanded,
  onToggle,
  onSave,
  isSaving,
  savedOk,
  inputClass,
}: {
  bank: BankListItem;
  isExpanded: boolean;
  onToggle: () => void;
  onSave: (fields: Record<string, unknown>) => void;
  isSaving: boolean;
  savedOk: boolean;
  inputClass: string;
}) {
  const [showOnPaymentLink, setShowOnPaymentLink] = useState<boolean>(
    bank.showOnPaymentLink ?? false,
  );
  const [accountNumber, setAccountNumber] = useState<string>(bank.accountNumber ?? "");
  const [routingNumber, setRoutingNumber] = useState<string>(bank.routingNumber ?? "");
  const [swiftCode, setSwiftCode] = useState<string>(bank.swiftCode ?? "");
  const [iban, setIban] = useState<string>(bank.iban ?? "");
  const [qrCodeUrl, setQrCodeUrl] = useState<string>(bank.qrCodeUrl ?? "");

  useEffect(() => {
    setShowOnPaymentLink(bank.showOnPaymentLink ?? false);
    setAccountNumber(bank.accountNumber ?? "");
    setRoutingNumber(bank.routingNumber ?? "");
    setSwiftCode(bank.swiftCode ?? "");
    setIban(bank.iban ?? "");
    setQrCodeUrl(bank.qrCodeUrl ?? "");
  }, [bank]);

  function handleSave() {
    onSave({ showOnPaymentLink, accountNumber, routingNumber, swiftCode, iban, qrCodeUrl });
  }

  return (
    <div className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden">
      {/* Card header — always visible */}
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#f8fafc] to-[#e2e8f0] dark:from-white/10 dark:to-white/5 flex items-center justify-center text-sm font-bold text-[#334155] dark:text-white/60 border border-[#e2e8f0] dark:border-white/10 shrink-0">
            {bank.accountName?.charAt(0)?.toUpperCase() ?? "B"}
          </div>
          <div>
            <div className="text-sm font-semibold text-[#1e293b] dark:text-white">
              {bank.accountName}
            </div>
            <div className="text-xs text-[#94a3b8] dark:text-white/30">
              {bank.institutionName ?? "Manual"} · {bank.accountType} ·{" "}
              {bank.lastFour ? `••••${bank.lastFour}` : "no last four"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {showOnPaymentLink && (
            <span className="text-xs font-semibold text-[#0d9488] bg-[#f0fdf4] dark:bg-teal-900/20 px-2.5 py-1 rounded-full">
              Invoice payments ✓
            </span>
          )}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-[#94a3b8] transition-transform ${isExpanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {/* Expanded detail panel */}
      {isExpanded && (
        <div className="border-t border-[#e2e8f0] dark:border-white/10 px-5 py-5 space-y-5">
          {/* Toggle */}
          <div className="flex items-center justify-between py-3 px-4 rounded-xl bg-[#f8fafc] dark:bg-white/5 border border-[#e2e8f0] dark:border-white/10">
            <div>
              <div className="text-sm font-semibold text-[#1e293b] dark:text-white">
                Show on invoice payment links
              </div>
              <div className="text-xs text-[#64748b] dark:text-white/40 mt-0.5">
                Customers will see this bank&apos;s wire details when paying
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowOnPaymentLink(!showOnPaymentLink)}
              className={`touch-target relative w-12 h-6 rounded-full transition-colors ${
                showOnPaymentLink ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/20"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  showOnPaymentLink ? "translate-x-6" : ""
                }`}
              />
            </button>
          </div>

          {/* Wire details */}
          <div>
            <p className="text-xs font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-widest mb-3">
              Wire Transfer Details
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                  Full Account Number
                </label>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="e.g. 123456789012"
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                    Routing Number (ABA)
                  </label>
                  <input
                    type="text"
                    value={routingNumber}
                    onChange={(e) => setRoutingNumber(e.target.value)}
                    placeholder="e.g. 021000021"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                    SWIFT / BIC
                  </label>
                  <input
                    type="text"
                    value={swiftCode}
                    onChange={(e) => setSwiftCode(e.target.value)}
                    placeholder="e.g. MRYYUS33"
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                  IBAN (International)
                </label>
                <input
                  type="text"
                  value={iban}
                  onChange={(e) => setIban(e.target.value)}
                  placeholder="e.g. GB29 NWBK 6016 1331 9268 19"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                  QR Code URL (optional)
                </label>
                <input
                  type="url"
                  value={qrCodeUrl}
                  onChange={(e) => setQrCodeUrl(e.target.value)}
                  placeholder="https://example.com/qr.png"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-[#94a3b8] dark:text-white/30">
                  Customers can scan this QR to pay via mobile banking or e-wallets.
                </p>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-semibold transition-all"
            >
              {isSaving ? "Saving…" : savedOk ? "Saved ✓" : "Save Changes"}
            </button>
            {savedOk && (
              <span className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
                Bank account updated
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Revenue Section — Stripe + PayPal
// ============================================================================

function RevenueSection({
  orgId,
  config,
  isLoading,
  queryClient,
  inputClass,
}: {
  orgId: string;
  config: PaymentGatewayConfig | undefined;
  isLoading: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
  inputClass: string;
}) {
  const [stripeExpanded, setStripeExpanded] = useState(false);
  const [paypalExpanded, setPaypalExpanded] = useState(false);

  // Stripe state
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [stripePubKey, setStripePubKey] = useState("");
  const [stripeSecKey, setStripeSecKey] = useState("");
  const [stripeWebhook, setStripeWebhook] = useState("");
  const [showStripeSecKey, setShowStripeSecKey] = useState(false);

  // PayPal state
  const [paypalEnabled, setPaypalEnabled] = useState(false);
  const [paypalClientId, setPaypalClientId] = useState("");
  const [paypalClientSecret, setPaypalClientSecret] = useState("");
  const [paypalMode, setPaypalMode] = useState<"sandbox" | "live">("sandbox");
  const [showPaypalSecret, setShowPaypalSecret] = useState(false);

  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!config) return;
    const p = config.paymentProvider;
    setStripeEnabled(p === "stripe" || p === "both");
    setPaypalEnabled(p === "paypal" || p === "both");
    setStripePubKey(config.stripePublishableKey);
    setStripeSecKey(""); // secret — not returned by server; user must re-enter to change
    setStripeWebhook(""); // secret — not returned by server; user must re-enter to change
    setPaypalClientId(config.paypalClientId);
    setPaypalClientSecret(""); // secret — not returned by server; user must re-enter to change
    setPaypalMode(config.paypalMode);
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: (data: unknown) =>
      (savePaymentGatewayConfig as (opts: { data: unknown }) => Promise<{ success: boolean }>)({
        data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-gateway-config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  function deriveProvider(): PaymentGatewayConfig["paymentProvider"] {
    if (stripeEnabled && paypalEnabled) return "both";
    if (stripeEnabled) return "stripe";
    if (paypalEnabled) return "paypal";
    return "none";
  }

  function handleSave() {
    saveMutation.mutate({
      organizationId: orgId,
      paymentProvider: deriveProvider(),
      stripePublishableKey: stripePubKey,
      stripeSecretKey: stripeSecKey,
      stripeWebhookSecret: stripeWebhook,
      paypalClientId,
      paypalClientSecret,
      paypalMode,
    });
  }

  function maskKey(key: string) {
    if (!key || key.length < 12) return key;
    return `${key.slice(0, 8)}${"•".repeat(Math.min(key.length - 12, 24))}${key.slice(-4)}`;
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-[#f1f5f9] dark:bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  const stripeConnected = stripeEnabled && !!stripeSecKey;
  const paypalConnected = paypalEnabled && !!paypalClientId;

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">Revenue</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Connect payment gateways so customers can pay invoices online.
      </p>

      <div className="space-y-4">
        {/* Stripe */}
        <GatewayCard
          name="Stripe"
          domain="stripe.com"
          emoji="💳"
          gradient="from-[#635bff] to-[#4f46e5]"
          description="Let customers pay invoices with credit cards, debit cards, and more. Stripe handles all PCI compliance automatically."
          connected={stripeConnected}
          enabled={stripeEnabled}
          isExpanded={stripeExpanded}
          onToggleExpand={() => setStripeExpanded(!stripeExpanded)}
          onToggleEnabled={() => setStripeEnabled(!stripeEnabled)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                Publishable Key
                <span className="ml-2 font-normal text-[#94a3b8]">(safe to expose to browser)</span>
              </label>
              <input
                type="text"
                value={stripePubKey}
                onChange={(e) => setStripePubKey(e.target.value)}
                placeholder="pk_live_... or pk_test_..."
                className={inputClass}
              />
              {stripePubKey.startsWith("pk_test_") && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ Test key detected — switch to live keys before going to production.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                Secret Key
              </label>
              <div className="relative">
                <input
                  type={showStripeSecKey ? "text" : "password"}
                  value={showStripeSecKey ? stripeSecKey : maskKey(stripeSecKey)}
                  onChange={(e) => setStripeSecKey(e.target.value)}
                  placeholder="sk_live_..."
                  className={`${inputClass} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setShowStripeSecKey(!showStripeSecKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94a3b8] hover:text-[#64748b] text-xs"
                >
                  {showStripeSecKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                Webhook Secret
                <span className="ml-2 font-normal text-[#94a3b8]">
                  (optional — for auto-mark-as-paid)
                </span>
              </label>
              <input
                type="password"
                value={stripeWebhook}
                onChange={(e) => setStripeWebhook(e.target.value)}
                placeholder="whsec_..."
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-[#94a3b8] dark:text-white/30">
                Set your Stripe webhook endpoint to:{" "}
                <code className="bg-[#f1f5f9] dark:bg-white/10 px-1 py-0.5 rounded text-[10px]">
                  {typeof window !== "undefined" ? window.location.origin : "https://yourapp.com"}
                  /api/payments/stripe-webhook
                </code>
              </p>
            </div>
          </div>
        </GatewayCard>

        {/* PayPal */}
        <GatewayCard
          name="PayPal"
          domain="paypal.com"
          emoji="🅿️"
          gradient="from-[#003087] to-[#009cde]"
          description="Accept PayPal and credit card payments. Customers can pay directly on the invoice page using PayPal Smart Buttons."
          connected={paypalConnected}
          enabled={paypalEnabled}
          isExpanded={paypalExpanded}
          onToggleExpand={() => setPaypalExpanded(!paypalExpanded)}
          onToggleEnabled={() => setPaypalEnabled(!paypalEnabled)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                Client ID
              </label>
              <input
                type="text"
                value={paypalClientId}
                onChange={(e) => setPaypalClientId(e.target.value)}
                placeholder="AXxx... or sandbox client ID"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                Client Secret
              </label>
              <div className="relative">
                <input
                  type={showPaypalSecret ? "text" : "password"}
                  value={showPaypalSecret ? paypalClientSecret : maskKey(paypalClientSecret)}
                  onChange={(e) => setPaypalClientSecret(e.target.value)}
                  placeholder="Client secret"
                  className={`${inputClass} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setShowPaypalSecret(!showPaypalSecret)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94a3b8] hover:text-[#64748b] text-xs"
                >
                  {showPaypalSecret ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
                Mode
              </label>
              <div className="flex gap-3">
                {(["sandbox", "live"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPaypalMode(m)}
                    className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-all capitalize ${
                      paypalMode === m
                        ? "border-[#0d9488] bg-[#f0fdf4] dark:bg-teal-900/20 text-[#0d9488] dark:text-teal-400"
                        : "border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/40 hover:border-[#0d9488]/40"
                    }`}
                  >
                    {m === "sandbox" ? "🧪 Sandbox" : "🚀 Live"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </GatewayCard>
      </div>

      {/* Save */}
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-semibold transition-all"
        >
          {saveMutation.isPending ? "Saving…" : saved ? "Saved ✓" : "Save Payment Settings"}
        </button>
        {saved && (
          <span className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
            Payment configuration saved
          </span>
        )}
        {saveMutation.isError && (
          <span className="text-xs text-red-500 font-medium">Failed to save. Please retry.</span>
        )}
      </div>
    </div>
  );
}

function GatewayCard({
  name,
  domain,
  emoji,
  gradient: _gradient,
  description,
  connected,
  enabled,
  isExpanded,
  onToggleExpand,
  onToggleEnabled,
  children,
}: {
  name: string;
  domain: string;
  emoji: string;
  gradient: string;
  description: string;
  connected: boolean;
  enabled: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden">
      <div className="flex items-start gap-4 px-6 py-5">
        <span className="text-3xl shrink-0">{emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base font-bold text-[#1e293b] dark:text-white">{name}</span>
            <span className="text-xs text-[#94a3b8] dark:text-white/30">{domain}</span>
            <span
              className={`ml-1 inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                connected
                  ? "bg-[#dcfce7] dark:bg-green-900/30 text-[#16a34a] dark:text-green-400"
                  : "bg-[#f1f5f9] dark:bg-white/5 text-[#94a3b8] dark:text-white/30"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#16a34a]" : "bg-[#94a3b8]"}`}
              />
              {connected ? "Connected" : "Not configured"}
            </span>
          </div>
          <p className="text-xs text-[#64748b] dark:text-white/40 leading-relaxed">{description}</p>
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-semibold text-[#64748b] dark:text-white/50 hover:text-[#0d9488] hover:border-[#0d9488] transition-all shrink-0"
        >
          {isExpanded ? "Collapse" : connected ? "Manage" : "Connect"}
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-[#e2e8f0] dark:border-white/10 px-6 py-5 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between py-3 px-4 rounded-xl bg-[#f8fafc] dark:bg-white/5 border border-[#e2e8f0] dark:border-white/10">
            <div>
              <div className="text-sm font-semibold text-[#1e293b] dark:text-white">
                Enable {name} for invoice payments
              </div>
              <div className="text-xs text-[#64748b] dark:text-white/40 mt-0.5">
                When enabled, customers will see the {name} payment option
              </div>
            </div>
            <button
              type="button"
              onClick={onToggleEnabled}
              className={`touch-target relative w-12 h-6 rounded-full transition-colors shrink-0 ${
                enabled ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/20"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  enabled ? "translate-x-6" : ""
                }`}
              />
            </button>
          </div>

          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Coming Soon Section
// ============================================================================

function ComingSoonSection({ title }: { title: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">{title}</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Integrations for {title.toLowerCase()} are coming soon.
      </p>
      <div className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-10 text-center">
        <div className="text-4xl mb-4">🔌</div>
        <p className="text-sm font-semibold text-[#1e293b] dark:text-white mb-2">Coming Soon</p>
        <p className="text-xs text-[#94a3b8] dark:text-white/30">
          {title} integrations are planned for a future release.
        </p>
      </div>
    </div>
  );
}
