import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppErrorBoundary } from "@/components/error/AppErrorBoundary";
import ProposalReviewCard from "@/components/ai/ProposalReviewCard";
import CoaProposalReviewCard from "@/components/ai/CoaProposalReviewCard";
import { callServerFn } from "@/lib/server-fn-client";
import { listAiProposals } from "./api/-ai-proposals";
import type { AiProposalKind, AiProposalStatus } from "@/db/schema/ai";

export const Route = createFileRoute("/ai-proposals")({
  component: () => (
    <AppErrorBoundary contextLabel="AI proposals">
      <AiProposalsPage />
    </AppErrorBoundary>
  ),
});

type StatusTab = "pending" | "approved" | "rejected" | "all";

const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

const KIND_OPTIONS: { value: AiProposalKind; label: string }[] = [
  { value: "create_party", label: "New record" },
  { value: "document_type", label: "Document type" },
  { value: "prefill", label: "Prefill" },
  { value: "match", label: "Match" },
  { value: "categorize", label: "Categorize" },
  { value: "create_txn", label: "New transaction" },
  { value: "date_fix", label: "Date fix" },
  { value: "split", label: "Split" },
  { value: "coa_accounts", label: "Chart of accounts" },
  { value: "category_mapping", label: "Posting defaults" },
];

/** Batch kinds get their own per-row review surface. */
const COA_KINDS = new Set<AiProposalKind>(["coa_accounts", "category_mapping"]);

/** Client-side view of an ai_action_proposals row (see src/db/schema/ai.ts). */
interface ProposalListRow {
  id: string;
  kind: AiProposalKind;
  proposal: Record<string, unknown>;
  confidence: string | null;
  status: AiProposalStatus;
  createdAt: string | Date;
  sourceRef: { entityType: string; entityId: string } | null;
}

function AiProposalsPage() {
  const queryClient = useQueryClient();
  const [statusTab, setStatusTab] = useState<StatusTab>("pending");
  const [kind, setKind] = useState<"" | AiProposalKind>("");

  const proposalsQuery = useQuery({
    queryKey: ["ai-proposals", statusTab, kind],
    queryFn: () =>
      callServerFn(listAiProposals, {
        data: {
          ...(statusTab !== "all" ? { status: statusTab } : {}),
          ...(kind ? { kind } : {}),
          limit: 100,
        },
      }),
  });
  const proposals = (proposalsQuery.data ?? []) as ProposalListRow[];

  return (
    <main className="min-h-full bg-slate-100 p-3 sm:p-6 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-3xl">
        <header className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-400">
            Confirm-first AI
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">AI Proposals</h1>
          <p className="mt-1 text-sm text-slate-500">
            Nothing the AI suggests is written until a permitted human approves it here.
          </p>
        </header>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusTab(tab.key)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  statusTab === tab.key
                    ? "bg-teal-700 text-white"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as "" | AiProposalKind)}
            aria-label="Filter by proposal kind"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-base sm:text-sm outline-none focus:border-teal-500 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {proposalsQuery.isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-white dark:bg-slate-900" />
            ))}
          </div>
        )}

        {proposalsQuery.isError && (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">Proposals could not be loaded</h2>
            <p className="mt-1 text-sm text-slate-500">
              {proposalsQuery.error instanceof Error
                ? proposalsQuery.error.message
                : "Please try again."}
            </p>
            <button
              type="button"
              onClick={() => proposalsQuery.refetch()}
              className="mt-3 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white"
            >
              Try again
            </button>
          </div>
        )}

        {!proposalsQuery.isLoading && !proposalsQuery.isError && proposals.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
            <p className="text-sm font-medium">
              {statusTab === "pending" ? "No proposals awaiting review" : "No proposals found"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {statusTab === "pending"
                ? "AI suggestions from document parsing and classification will appear here."
                : "Try a different status or kind filter."}
            </p>
          </div>
        )}

        {!proposalsQuery.isLoading && !proposalsQuery.isError && proposals.length > 0 && (
          <div className="space-y-3">
            {proposals.map((row) => (
              <div key={row.id}>
                {COA_KINDS.has(row.kind) ? (
                  <CoaProposalReviewCard
                    proposalId={row.id}
                    kind={row.kind as "coa_accounts" | "category_mapping"}
                    proposal={row.proposal}
                    status={row.status}
                    onDone={() => {
                      void queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
                    }}
                  />
                ) : (
                  <ProposalReviewCard
                    proposalId={row.id}
                    kind={row.kind}
                    proposal={row.proposal}
                    confidence={row.confidence != null ? Number(row.confidence) : undefined}
                    status={row.status}
                    onDone={() => {
                      void queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
                    }}
                  />
                )}
                <p className="mt-1 px-1 text-[10px] text-slate-400 dark:text-slate-500">
                  Proposed {new Date(row.createdAt).toLocaleString()}
                  {row.sourceRef ? ` · from ${row.sourceRef.entityType}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
