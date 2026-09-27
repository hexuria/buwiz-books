/**
 * The Inbox v2 reading pane: the matching extracted editor, prefilled from the candidate, under a
 * thin strip that says why the item needs a human and carries Approve / Reject.
 *
 * Nothing here posts. The editor's Save runs the existing candidate correction; Approve runs that
 * same correction first when the editor has unsaved changes, then asks the page to approve — and
 * approval posts through the shared posting cores.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission, useRole } from "@/lib/use-permission";
import type { InboxV2ListItem } from "@/lib/inbox/v2/list";
import { deriveInboxV2Kind, formatSourceBadge, INBOX_V2_KIND_LABELS } from "@/lib/inbox/v2/triage";
import {
  getInboxItem,
  resolveInboxFinding,
  retryInboundEmailProcessing,
  updateInboxCandidate,
} from "@/routes/api/-inbox";
import { getInboxSettings } from "@/routes/api/-inbox-settings";
import { getMappedAccounts } from "@/routes/api/-category-mappings";
import { getDocumentViewerData } from "@/routes/api/-documents";
import { BillEditor, type BillCategoryAccount, type BillEditorHandle } from "../bills/BillEditor";
import type { BoundingBox } from "../bills/InteractiveDocumentViewer";
import { DuplicateCasePanel } from "../inbox/DuplicateCasePanel";
import {
  TransactionEditor,
  type TransactionEditorHandle,
} from "../transactions/editor/TransactionEditor";
import { useToast } from "../ui/Toast";
import {
  billDraftToCorrection,
  candidateToBillEditorDraft,
  candidateToEditorDraft,
  candidateToTransactionEditorDraft,
  transactionDraftToCorrection,
  type CandidateCorrection,
  type DraftSourceCandidate,
  type EditorDraft,
} from "./candidate-draft";
import { ReasonChip } from "./ReasonChip";

const InteractiveDocumentViewer = lazy(() => import("../bills/InteractiveDocumentViewer"));

export type InboxDetail = Awaited<ReturnType<typeof getInboxItem>>;

export interface ApproveRequest {
  item: InboxV2ListItem;
  expectedRevision: number;
  expectedLockVersion: number;
  overrideReason?: string;
}

export interface RejectRequest {
  item: InboxV2ListItem;
  expectedLockVersion: number;
  reason: string;
}

export interface InboxV2PaneHandle {
  approve: () => void;
  startReject: () => void;
  focusEditor: () => void;
}

const EDITABLE_STATES = new Set(["needs_information", "ready_for_review"]);
const APPROVABLE_STATES = EDITABLE_STATES;
const REJECTABLE_STATES = new Set(["received", "needs_information", "ready_for_review", "failed"]);
const BILL_CATEGORY_TYPES = new Set(["expense", "cost_of_revenue", "other_expense"]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function blockingFindings(detail: InboxDetail) {
  return detail.findings.filter(
    (finding) => finding.state === "open" && finding.impact === "blocking",
  );
}

function draftSource(detail: InboxDetail): DraftSourceCandidate {
  return {
    transactionType: detail.candidate.transactionType,
    transactionDate: detail.candidate.transactionDate,
    memo: detail.candidate.memo,
    referenceNumber: detail.candidate.referenceNumber,
    partyId: detail.candidate.partyId,
    originalTotal: detail.candidate.originalTotal,
    lines: detail.lines.map((line) => ({
      id: line.id,
      accountId: line.accountId,
      originalDebit: line.originalDebit,
      originalCredit: line.originalCredit,
      lineDescription: line.lineDescription,
      departmentId: line.departmentId,
      locationId: line.locationId,
    })),
  };
}

/** Expense-like leaf accounts, plus any account a line already uses so it never displays wrong. */
function billCategoryAccounts(detail: InboxDetail, draft: EditorDraft): BillCategoryAccount[] {
  const used = new Set(
    draft.editor === "bill" ? draft.draft.lineItems.map((line) => line.accountId) : [],
  );
  return detail.accountOptions.filter(
    (account) => BILL_CATEGORY_TYPES.has(account.accountType) || used.has(account.id),
  );
}

interface InboxV2PaneProps {
  item: InboxV2ListItem;
  onApprove: (request: ApproveRequest) => void;
  onReject: (request: RejectRequest) => void;
  /** An approval or rejection of this item is already in flight. */
  deciding?: boolean;
  ref?: Ref<InboxV2PaneHandle>;
}

export function InboxV2Pane({
  item,
  onApprove,
  onReject,
  deciding = false,
  ref,
}: InboxV2PaneProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: session } = authClient.useSession();
  const { role } = useRole();
  const { canAccess: canApprove } = usePermission("inbox", "approve");
  const { canAccess: canReject } = usePermission("inbox", "reject");
  const { canAccess: canUpdate } = usePermission("inbox", "update");
  const { canAccess: canResolve } = usePermission("review", "resolve");

  const detailQuery = useQuery({
    queryKey: keys.inbox.detail(item.id),
    queryFn: () => callServerFn(getInboxItem, { data: { id: item.id } }),
  });
  const settingsQuery = useQuery({
    queryKey: keys.inbox.settings(),
    queryFn: () => callServerFn(getInboxSettings, { data: undefined }),
  });
  // Server-resolved, like the Bills editor: a bill's payable side and new lines' default.
  const mappedQuery = useQuery({
    queryKey: keys.categoryMappings.resolved("bill", ["accounts_payable", "default_expense"]),
    // getMappedAccounts parses its own input, so its declared input type is `undefined`.
    queryFn: () =>
      callServerFn(
        getMappedAccounts as (opts: { data: unknown }) => Promise<Record<string, string | null>>,
        { data: { mappingType: "bill", sourceKeys: ["accounts_payable", "default_expense"] } },
      ),
    staleTime: 5 * 60 * 1000,
  });

  const detail = detailQuery.data;
  const [bookAs, setBookAs] = useState<"auto" | "bill" | "transaction">("auto");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [preparing, setPreparing] = useState(false);
  const billRef = useRef<BillEditorHandle>(null);
  const transactionRef = useRef<TransactionEditorHandle>(null);
  const rejectInputRef = useRef<HTMLTextAreaElement>(null);
  // A second "a" or Enter can land before the re-render that disables the buttons; one decision
  // per item until the page's decision for it settles.
  const actingRef = useRef(false);
  useEffect(() => {
    if (!deciding) actingRef.current = false;
  }, [deciding]);

  const kind = detail
    ? deriveInboxV2Kind({
        candidateType: detail.candidate.candidateType,
        originEconomicEventClass: detail.economicEvent?.economicEventClass ?? null,
        transactionType: detail.candidate.transactionType,
      })
    : item.kind;

  const billPossible = useMemo(
    () => (detail ? candidateToBillEditorDraft(draftSource(detail)) !== null : false),
    [detail],
  );
  const editorDraft = useMemo((): EditorDraft | null => {
    if (!detail) return null;
    const source = draftSource(detail);
    if (bookAs === "bill") {
      return (
        candidateToBillEditorDraft(source, { rebook: kind !== "vendor_bill" }) ??
        candidateToEditorDraft(source, kind)
      );
    }
    if (bookAs === "transaction") return candidateToTransactionEditorDraft(source);
    return candidateToEditorDraft(source, kind);
  }, [detail, bookAs, kind]);

  const correctionContext = detail
    ? {
        originalCurrency: detail.candidate.originalCurrency,
        functionalCurrency: detail.candidate.functionalCurrency,
        exchangeRate: detail.candidate.exchangeRate,
      }
    : null;

  /** The editor's current content as a correction, or null (the reason was already shown). */
  const currentCorrection = (): CandidateCorrection | null => {
    if (!detail || !editorDraft || !correctionContext) return null;
    try {
      if (editorDraft.editor === "bill") {
        const handle = billRef.current;
        if (!handle) return null;
        return billDraftToCorrection(handle.getDraft(), {
          ...correctionContext,
          creditLine: editorDraft.creditLine,
          payableAccountId: mappedQuery.data?.accounts_payable ?? null,
        });
      }
      const handle = transactionRef.current;
      if (!handle || !handle.validate()) return null;
      return transactionDraftToCorrection(handle.getDraft(), {
        ...correctionContext,
        sourceReviewerEditable: detail.economicEvent?.reviewerEditable === true,
      });
    } catch (error) {
      showToast(errorMessage(error), { icon: "error" });
      return null;
    }
  };

  const saveMutation = useMutation({
    mutationFn: (correction: CandidateCorrection) => {
      if (!detail) throw new Error("This item is still loading.");
      return callServerFn(updateInboxCandidate, {
        data: {
          inboxItemId: detail.item.id,
          expectedRevision: detail.item.candidateRevision,
          expectedLockVersion: detail.item.lockVersion,
          ...correction,
        },
      });
    },
    onSuccess: async () => {
      showToast("Saved. The book checks ran again.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  const saveFromEditor = (build: () => CandidateCorrection) => {
    try {
      saveMutation.mutate(build());
    } catch (error) {
      showToast(errorMessage(error), { icon: "error" });
    }
  };

  // ── Decision gates ──
  const state = detail?.item.state ?? item.state;
  const blocking = detail ? blockingFindings(detail) : [];
  const settings = settingsQuery.data;
  const submittedByMe = Boolean(
    detail && session?.user?.id && detail.item.submittedBy === session.user.id,
  );
  const differentApproverRequired = Boolean(settings?.requireDifferentApprover && submittedByMe);
  const ownerMayOverride =
    differentApproverRequired && role === "owner" && Boolean(settings?.allowOwnerOverride);
  const busy = deciding || preparing || saveMutation.isPending;

  const approveBlocker = ((): string | null => {
    if (!detail) return "This item is still loading.";
    if (!canApprove) return "You do not have permission to approve Inbox items.";
    if (!APPROVABLE_STATES.has(state)) {
      return state === "failed"
        ? "A failed item can be rejected or retried, not approved."
        : "This item is still being processed.";
    }
    if (editorDraft?.editor === "bill" && mappedQuery.isPending) {
      return "This item is still loading.";
    }
    if (blocking.length > 0) {
      return blocking.length === 1
        ? "Fix or resolve the blocking check first."
        : `Fix or resolve the ${blocking.length} blocking checks first.`;
    }
    if (differentApproverRequired && !ownerMayOverride) {
      return "A different reviewer must approve an item you submitted.";
    }
    if (ownerMayOverride && !overrideReason.trim()) {
      return "Give an owner override reason to approve your own submission.";
    }
    if (busy) return "Working on it…";
    return null;
  })();
  const rejectBlocker = ((): string | null => {
    if (!detail) return "This item is still loading.";
    if (!canReject) return "You do not have permission to reject Inbox items.";
    if (!REJECTABLE_STATES.has(state))
      return "This item cannot be rejected while it is processing.";
    if (busy) return "Working on it…";
    return null;
  })();

  const approve = async () => {
    if (actingRef.current) return;
    if (approveBlocker || !detail || !editorDraft) {
      if (approveBlocker) showToast(approveBlocker, { icon: "error" });
      return;
    }
    actingRef.current = true;
    let expectedRevision = detail.item.candidateRevision;
    let expectedLockVersion = detail.item.lockVersion;
    const handle = editorDraft.editor === "bill" ? billRef.current : transactionRef.current;
    const needsSave = (handle?.isDirty() ?? false) || detail.item.state !== "ready_for_review";
    if (needsSave) {
      // Unsaved edits go through the same correction as Save, then the checks run again.
      const correction = currentCorrection();
      if (!correction) {
        actingRef.current = false;
        return;
      }
      setPreparing(true);
      try {
        await callServerFn(updateInboxCandidate, {
          data: {
            inboxItemId: detail.item.id,
            expectedRevision,
            expectedLockVersion,
            ...correction,
          },
        });
        const fresh = await queryClient.fetchQuery({
          queryKey: keys.inbox.detail(item.id),
          queryFn: () => callServerFn(getInboxItem, { data: { id: item.id } }),
          staleTime: 0,
        });
        void queryClient.invalidateQueries({ queryKey: keys.inbox.v2List() });
        const nowBlocking = blockingFindings(fresh);
        if (nowBlocking.length > 0) {
          actingRef.current = false;
          showToast(`Saved, but a check now blocks approval: ${nowBlocking[0].message}`, {
            icon: "error",
          });
          return;
        }
        expectedRevision = fresh.item.candidateRevision;
        expectedLockVersion = fresh.item.lockVersion;
      } catch (error) {
        actingRef.current = false;
        showToast(errorMessage(error), { icon: "error" });
        return;
      } finally {
        setPreparing(false);
      }
    }
    onApprove({
      item,
      expectedRevision,
      expectedLockVersion,
      overrideReason: ownerMayOverride ? overrideReason.trim() : undefined,
    });
  };

  const startReject = () => {
    if (rejectBlocker) {
      showToast(rejectBlocker, { icon: "error" });
      return;
    }
    if (rejecting) rejectInputRef.current?.focus();
    else setRejecting(true);
  };

  const confirmReject = () => {
    if (actingRef.current || !detail || rejectBlocker || !rejectReason.trim()) return;
    actingRef.current = true;
    onReject({ item, expectedLockVersion: detail.item.lockVersion, reason: rejectReason.trim() });
  };

  useImperativeHandle(ref, () => ({
    approve: () => void approve(),
    startReject,
    focusEditor: () =>
      (editorDraft?.editor === "bill" ? billRef.current : transactionRef.current)?.focus(),
  }));

  // ── Render ──
  if (detailQuery.isPending) return <PaneSkeleton />;
  if (detailQuery.isError || !detail || !editorDraft) {
    return (
      <div className="p-6 text-sm text-rose-700 dark:text-rose-300" role="alert">
        <p className="font-semibold">This item could not be loaded.</p>
        <p className="mt-1">{errorMessage(detailQuery.error)}</p>
        <button
          type="button"
          onClick={() => detailQuery.refetch()}
          className="mt-3 rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  const editable = canUpdate && EDITABLE_STATES.has(state);
  const openDuplicates = detail.duplicateCases.filter(
    (duplicateCase) => duplicateCase.state === "open",
  );
  const canBookAs = editable && detail.economicEvent?.reviewerEditable === true;
  const editorKey = `${detail.item.id}:${detail.candidate.revision}:${bookAs}`;
  const primaryDocument = detail.documents[0] ?? null;
  const partyName = detail.partyName;

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Thin strip ── */}
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <div className="flex flex-wrap items-center gap-2">
          <ReasonChip reason={item.reason} />
          {item.sourceBadge && (
            <span
              className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300"
              title={
                item.sourceBadge.kind === "remembered"
                  ? "Answered from a correction you asked Jev to remember"
                  : "Jev's confidence in the weakest category on this entry"
              }
            >
              {formatSourceBadge(item.sourceBadge)}
            </span>
          )}
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {INBOX_V2_KIND_LABELS[kind]}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={startReject}
              disabled={rejectBlocker !== null}
              title={rejectBlocker ?? "Reject (r)"}
              className="h-9 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => void approve()}
              disabled={approveBlocker !== null}
              title={approveBlocker ?? "Approve (a)"}
              className="h-9 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
            >
              {preparing ? "Saving…" : deciding ? "Approving…" : "Approve"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{item.reasonText}</p>
        {approveBlocker && blocking.length > 0 && (
          <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
            {approveBlocker} Saving your edits runs the checks again.
          </p>
        )}
        {openDuplicates.length > 0 && (
          <p
            role="alert"
            className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          >
            Possible duplicate ({openDuplicates[0].score}% match). Compare it below and resolve the
            case before approving.
          </p>
        )}
        {ownerMayOverride && (
          <label className="mt-2 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Owner override reason
            <input
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder="Required to approve your own submission"
              className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-base outline-none focus:border-teal-500 sm:text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        )}
        {rejecting && (
          <div className="mt-3 space-y-2">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Why reject it?
              <textarea
                ref={rejectInputRef}
                autoFocus
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    confirmReject();
                  } else if (event.key === "Escape") {
                    setRejecting(false);
                  }
                }}
                rows={2}
                placeholder="Explain what is wrong with this paper"
                className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white p-2 text-base outline-none focus:border-teal-500 sm:text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className="h-8 rounded-md px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReject}
                disabled={!rejectReason.trim() || rejectBlocker !== null}
                className="h-8 rounded-md bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reject item
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        {canBookAs && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="font-medium">Book as</span>
            <div
              role="radiogroup"
              aria-label="Book as"
              className="inline-flex rounded-md border border-slate-200 p-0.5 dark:border-slate-700"
            >
              {(
                [
                  ["bill", "Vendor bill"],
                  ["transaction", "Transaction"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={editorDraft.editor === value}
                  disabled={value === "bill" && !billPossible}
                  title={
                    value === "bill" && !billPossible
                      ? "This entry is not expense lines against one payable, so it cannot open as a bill."
                      : undefined
                  }
                  onClick={() => setBookAs(value)}
                  className={`rounded px-2 py-1 font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    editorDraft.editor === value
                      ? "bg-teal-700 text-white"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {editorDraft.editor === "transaction" && editorDraft.fallback && (
          <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
            {editorDraft.fallback === "bill_shape"
              ? "This bill is not expense lines against one payable, so it opens as a journal entry with every line intact."
              : "This entry does not fit that tab without dropping a line, so it opens as a journal entry with every line intact."}
          </p>
        )}
        {kind === "sales_invoice" && (
          <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
            This looks like a sales invoice. Approving books the entry; it does not create an
            invoice record, so issue or track the invoice itself under Invoices.
          </p>
        )}
        {!editable && (
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
            {canUpdate
              ? "This item cannot be edited in its current state."
              : "You can review this item, but your role cannot edit it."}
          </p>
        )}

        {editorDraft.editor === "bill" && primaryDocument && (
          <DocumentPreview documentId={primaryDocument.id} />
        )}

        {editorDraft.editor === "bill" ? (
          <BillEditor
            key={editorKey}
            ref={billRef}
            draft={editorDraft.draft}
            onSubmit={(draft) =>
              saveFromEditor(() =>
                billDraftToCorrection(draft, {
                  ...correctionContext!,
                  creditLine: editorDraft.creditLine,
                  payableAccountId: mappedQuery.data?.accounts_payable ?? null,
                }),
              )
            }
            categoryAccounts={billCategoryAccounts(detail, editorDraft)}
            defaultLineAccountId={mappedQuery.data?.default_expense ?? ""}
            pending={saveMutation.isPending}
            submitDisabled={!editable || busy || mappedQuery.isPending}
            submitLabel="Save & run checks"
            title={partyName ? `Bill from ${partyName}` : "Vendor bill"}
            subtitle="Edit it like any bill. Approve books the accrual and adds it to Bills."
            headingLevel="h2"
            showDueDate={false}
            currency={detail.candidate.originalCurrency}
          />
        ) : (
          <TransactionEditor
            key={editorKey}
            ref={transactionRef}
            draft={editorDraft.draft}
            onSubmit={(draft) =>
              saveFromEditor(() =>
                transactionDraftToCorrection(draft, {
                  ...correctionContext!,
                  sourceReviewerEditable: detail.economicEvent?.reviewerEditable === true,
                }),
              )
            }
            partyOption={
              detail.candidate.partyId && partyName
                ? { value: detail.candidate.partyId, label: partyName }
                : null
            }
            pending={saveMutation.isPending}
            submitDisabled={!editable || busy}
            submitLabel="Save & run checks"
          />
        )}

        {detail.candidate.originalCurrency !== detail.candidate.functionalCurrency && (
          <p className="text-xs text-slate-500">
            Entered in {detail.candidate.originalCurrency} at {detail.candidate.exchangeRate} to{" "}
            {detail.candidate.functionalCurrency}. The rate is kept as captured.
          </p>
        )}

        {editorDraft.editor !== "bill" && detail.documents.length > 0 && (
          <PaneSection title={`Evidence (${detail.documents.length})`}>
            <ul className="space-y-1">
              {detail.documents.map((document) => (
                <li key={document.id}>
                  <a
                    href={`/documents/${document.id}`}
                    className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
                  >
                    {document.displayTitle || document.filename}
                  </a>
                  <span className="ml-2 text-xs text-slate-500">
                    {titleCase(document.documentType)}
                  </span>
                </li>
              ))}
            </ul>
          </PaneSection>
        )}

        <Checks detail={detail} canResolve={canResolve} />

        {openDuplicates.length > 0 && (
          <PaneSection title={`Possible duplicate (${openDuplicates.length})`}>
            <div className="space-y-3">
              {openDuplicates.map((duplicateCase) => (
                <DuplicateCasePanel
                  key={duplicateCase.id}
                  duplicateCase={duplicateCase}
                  canResolve={canResolve}
                />
              ))}
            </div>
          </PaneSection>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Pieces
// ============================================================================

function PaneSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Open findings, blocking first, with the resolve-with-a-note and retry actions. */
function Checks({ detail, canResolve }: { detail: InboxDetail; canResolve: boolean }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const open = detail.findings
    .filter((finding) => finding.state === "open")
    .sort((a, b) => Number(b.impact === "blocking") - Number(a.impact === "blocking"));

  const resolveMutation = useMutation({
    mutationFn: ({ findingId, note }: { findingId: string; note: string }) =>
      callServerFn(resolveInboxFinding, {
        data: {
          findingId,
          expectedLockVersion: detail.item.lockVersion,
          resolutionNote: note,
        },
      }),
    onSuccess: async () => {
      showToast("Check resolved with your note.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });
  const retryMutation = useMutation({
    mutationFn: (emailId: string) =>
      callServerFn(retryInboundEmailProcessing, { data: { emailId } }),
    onSuccess: async () => {
      showToast("Reprocessing queued. This item will update shortly.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  if (open.length === 0) {
    return (
      <PaneSection title="Checks">
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          Every book check passed.
        </p>
      </PaneSection>
    );
  }

  return (
    <PaneSection title={`Checks (${open.length})`}>
      <ul className="space-y-2">
        {open.map((finding) => {
          const emailId = (finding.evidence as { emailId?: unknown }).emailId;
          return (
            <li
              key={finding.id}
              className={`rounded-md border p-3 ${
                finding.impact === "blocking"
                  ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                  : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">{titleCase(finding.ruleKey)}</p>
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {finding.impact === "blocking" ? "Blocks approval" : "Warning"}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{finding.message}</p>
              {canResolve &&
                finding.ruleKey === "source_processing_failed" &&
                typeof emailId === "string" && (
                  <button
                    type="button"
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate(emailId)}
                    className="mt-2 h-8 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                  >
                    {retryMutation.isPending ? "Queuing…" : "Retry processing"}
                  </button>
                )}
              {canResolve && finding.ruleKey !== "possible_duplicate" && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={notes[finding.id] ?? ""}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [finding.id]: event.target.value }))
                    }
                    placeholder="Resolution or documented exception"
                    aria-label={`Resolution note for ${titleCase(finding.ruleKey)}`}
                    className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-base outline-none focus:border-teal-500 sm:text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <button
                    type="button"
                    disabled={
                      resolveMutation.isPending || (notes[finding.id]?.trim().length ?? 0) < 3
                    }
                    onClick={() =>
                      resolveMutation.mutate({
                        findingId: finding.id,
                        note: notes[finding.id] ?? "",
                      })
                    }
                    className="h-8 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    Resolve
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </PaneSection>
  );
}

/** The paper itself, for the Bills editor: the interactive viewer when a preview exists. */
function DocumentPreview({ documentId }: { documentId: string }) {
  const viewerQuery = useQuery({
    queryKey: keys.documents.viewer(documentId),
    queryFn: () => callServerFn(getDocumentViewerData, { data: { documentId } }),
    staleTime: 5 * 60 * 1000,
  });
  const viewer = viewerQuery.data;
  if (viewerQuery.isPending) {
    return <div className="h-48 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />;
  }
  const imageUrl = viewer?.imageUrl ?? viewer?.imageUrls?.[0] ?? null;
  if (!viewer || !imageUrl) {
    return (
      <a
        href={viewer?.documentUrl ?? `/documents/${documentId}`}
        target={viewer?.documentUrl ? "_blank" : undefined}
        rel="noopener noreferrer"
        className="inline-block text-sm font-semibold text-teal-700 hover:underline dark:text-teal-400"
      >
        Open the paper
      </a>
    );
  }
  return (
    <Suspense
      fallback={<div className="h-48 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />}
    >
      <InteractiveDocumentViewer
        imageUrl={imageUrl}
        imageUrls={viewer.imageUrls}
        documentUrl={viewer.documentUrl ?? undefined}
        boundingBoxes={(viewer.boundingBoxes ?? []) as BoundingBox[]}
        totalPages={viewer.pageCount}
      />
    </Suspense>
  );
}

function PaneSkeleton() {
  return (
    <div className="animate-pulse p-6" aria-label="Loading item">
      <div className="h-5 w-2/3 rounded bg-slate-200 dark:bg-slate-700" />
      <div className="mt-3 h-4 w-1/3 rounded bg-slate-100 dark:bg-slate-800" />
      {[1, 2, 3].map((row) => (
        <div key={row} className="mt-8 h-16 rounded bg-slate-100 dark:bg-slate-800" />
      ))}
    </div>
  );
}
