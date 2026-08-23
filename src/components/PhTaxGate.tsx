// ============================================================================
// Route-level PH tax module gate (audit D6).
//
// Wraps every payroll/tax page body:
//   off      → the page renders an empty state pointing at organization
//              settings (server mutations refuse anyway; this is the honest
//              front door).
//   archived → the page renders READ-ONLY under a banner. Server mutations
//              refuse with the same message, so the banner is a courtesy,
//              not the enforcement.
//   active   → children unchanged.
// ============================================================================
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { keys } from "../lib/query-keys";
import type { PhTaxModuleStatus } from "../lib/tax/module-state-types";
import { getTaxModuleState } from "../routes/api/-tax-module-state";
import { useActiveOrganization } from "../hooks/useActiveOrganization";

export function PhTaxGate({ children }: { children: React.ReactNode }) {
  const { data: status, isPending } = useQuery({
    queryKey: keys.tax.moduleState(),
    queryFn: () => (getTaxModuleState as () => Promise<PhTaxModuleStatus>)(),
    staleTime: 60_000,
  });
  const { data: activeOrg } = useActiveOrganization();

  if (isPending || !status) {
    return <div className="p-8 text-sm text-[#64748b] dark:text-white/50">Loading…</div>;
  }

  if (status.state === "off") {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 py-16 text-center">
        <div className="max-w-md space-y-3">
          <h2 className="text-lg font-semibold text-[#1e293b] dark:text-white">
            Philippine tax &amp; payroll is not enabled
          </h2>
          <p className="text-sm text-[#64748b] dark:text-white/50">
            Payroll, withholding, and BIR filing tools activate when this organization&apos;s
            country is set to the Philippines. Nothing is lost by switching later — records are
            archived, never deleted.
          </p>
          {activeOrg?.id ? (
            <Link
              to={"/organization/$orgId/settings" as string & {}}
              params={{ orgId: activeOrg.id } as never}
              className="inline-block px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] text-white text-sm font-medium no-underline transition-all"
            >
              Set organization country
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  if (status.state === "archived") {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 sm:px-8 py-3 bg-[#fffbeb] dark:bg-amber-900/10 border-b border-[#fde68a] dark:border-amber-900/30">
          <p className="text-sm text-[#92400e] dark:text-amber-300">
            <span className="font-semibold">Archived.</span> This organization&apos;s country is no
            longer the Philippines, so payroll and tax records are read-only. Everything stays
            viewable and exportable; set the country back to Philippines to resume.
          </p>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    );
  }

  return <>{children}</>;
}
