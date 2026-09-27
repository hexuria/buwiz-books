/**
 * Settings → Jev approval (Inbox v2 spec §8, §10).
 *
 * Jev earns the right to approve papers one lane at a time — one vendor or
 * customer and one kind of paper. Each lane shows how often people agreed with
 * Jev, how many reviewed papers that rests on, the lane's calibration (how
 * often each confidence level was right), and its limits once it approves.
 * Admins turn the organization's Jev approval on or off, set the spot-check
 * share, and promote or demote lanes; promotion is refused unless the lane has
 * earned it at that moment.
 *
 * `JevLanesPanel` is presentational; `JevLanesSettings` wires it to the server
 * functions and is what the settings page mounts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { useToast } from "@/components/ui/Toast";
import { INBOX_V2_KIND_LABELS, type InboxV2Kind } from "@/lib/inbox/v2/triage";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import {
  demoteJevLane,
  listJevLanes,
  promoteJevLane,
  updateJevApprovalSettingsFn,
  type JevLaneView,
  type JevLanesView,
} from "@/routes/api/-jev-lanes";

export interface JevPromotion {
  laneId: string;
  to: "suggest" | "auto";
  amountCap?: string;
  confidenceThreshold?: string;
}

export interface JevSettingsPatch {
  autoApproveEnabled?: boolean;
  makerCheckerOptIn?: boolean;
  spotCheckRate?: string;
}

export interface JevLanesPanelProps {
  view: JevLanesView;
  busy?: boolean;
  error?: string | null;
  onUpdateSettings: (patch: JevSettingsPatch) => void;
  onPromote: (promotion: JevPromotion) => void;
  onDemote: (demotion: { laneId: string; to: "watch" | "suggest" }) => void;
}

const LEVEL_LABELS: Record<JevLaneView["level"], string> = {
  watch: "Watch",
  suggest: "Suggest",
  auto: "Auto",
};

const LEVEL_BLURBS: Record<JevLaneView["level"], string> = {
  watch: "Jev's answers are checked against what people decide. Nothing else changes.",
  suggest: "The Inbox says when Jev would approve a paper. A person still approves it.",
  auto: "Jev approves papers that pass every check, except a spot-check share it leaves for a person.",
};

const INPUT =
  "min-h-11 lg:min-h-0 w-28 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] px-2 py-1.5 text-sm text-[#1e293b] dark:text-white disabled:opacity-50";
const BUTTON =
  "min-h-11 lg:min-h-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40";

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** A 0..1 rate as the whole or one-decimal percent an admin types. */
function ratePercent(rate: number): string {
  return String(Math.round(rate * 1000) / 10);
}

export function laneTitle(lane: Pick<JevLaneView, "partyName" | "docKind">): string {
  const kind = lane.docKind
    ? (INBOX_V2_KIND_LABELS[lane.docKind as InboxV2Kind] ?? lane.docKind)
    : "Any paper";
  return `${lane.partyName ?? "No vendor or customer"} · ${kind}`;
}

function agreementText(lane: JevLaneView): string {
  const { labeled, accepted, remembered } = lane.agreement;
  if (labeled === 0) return "No reviewed papers yet.";
  const rememberedNote = remembered > 0 ? ` (${remembered} remembered)` : "";
  return `Agreement ${percent(accepted / labeled)} · ${labeled} reviewed${rememberedNote}`;
}

function wouldApproveText(lane: JevLaneView): string | null {
  const { wouldApprove, wouldApproveUndone } = lane.agreement;
  if (wouldApprove === 0) return null;
  return `Jev would have approved ${wouldApprove}; people changed ${wouldApproveUndone} of them.`;
}

function LaneRow({
  lane,
  canConfigure,
  busy,
  onPromote,
  onDemote,
}: {
  lane: JevLaneView;
  canConfigure: boolean;
  busy: boolean;
  onPromote: JevLanesPanelProps["onPromote"];
  onDemote: JevLanesPanelProps["onDemote"];
}) {
  const title = laneTitle(lane);
  const capId = useId();
  const thresholdId = useId();
  const [promotingToAuto, setPromotingToAuto] = useState(false);
  const [cap, setCap] = useState(lane.amountCap ? String(Number(lane.amountCap)) : "");
  const [threshold, setThreshold] = useState(
    lane.calibration.minimumThreshold !== null ? String(lane.calibration.minimumThreshold) : "",
  );
  const disabled = !canConfigure || busy;

  // Why the next promotion is not available, if it is not.
  const promoteBlocker = !lane.eligibility.eligible
    ? lane.eligibility.reason
    : lane.level === "suggest" && !lane.partyId
      ? "A lane without a vendor or customer can never approve: new parties always need a person."
      : lane.level === "suggest" && lane.calibration.minimumThreshold === null
        ? lane.calibration.reason
        : null;

  const submitAuto = (event: FormEvent) => {
    event.preventDefault();
    onPromote({
      laneId: lane.id,
      to: "auto",
      amountCap: cap.trim(),
      confidenceThreshold: threshold.trim(),
    });
  };

  const buckets = lane.calibration.buckets.filter((bucket) => bucket.reviewed > 0);
  const wouldApprove = wouldApproveText(lane);

  return (
    <li aria-label={title} className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[#1e293b] dark:text-white">{title}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            lane.level === "auto"
              ? "bg-[#0d9488]/10 text-[#0d9488] dark:text-teal-300"
              : "bg-[#f1f5f9] dark:bg-white/5 text-[#64748b] dark:text-white/50"
          }`}
        >
          {LEVEL_LABELS[lane.level]}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-[#94a3b8] dark:text-white/40">
        {LEVEL_BLURBS[lane.level]}
      </p>
      <p className="mt-1 text-xs text-[#64748b] dark:text-white/60">{agreementText(lane)}</p>
      {wouldApprove && <p className="text-xs text-[#64748b] dark:text-white/60">{wouldApprove}</p>}
      {lane.level === "auto" && lane.amountCap && lane.confidenceThreshold && (
        <p className="text-xs text-[#64748b] dark:text-white/60">
          Approves up to {Number(lane.amountCap).toLocaleString("en-US")} at confidence{" "}
          {Number(lane.confidenceThreshold)} or higher.
        </p>
      )}
      {lane.demotedAt && (
        <p className="text-[11px] text-[#b45309] dark:text-amber-300">
          Demoted {new Date(lane.demotedAt).toISOString().slice(0, 10)}.
        </p>
      )}

      {buckets.length > 0 && (
        <table className="mt-2 text-left text-[11px] text-[#64748b] dark:text-white/50">
          <caption className="sr-only">Calibration for {title}</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-3 font-medium">
                Jev&apos;s confidence
              </th>
              <th scope="col" className="pr-3 font-medium">
                Reviewed
              </th>
              <th scope="col" className="font-medium">
                Accepted
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.lower}>
                <td className="pr-3">
                  {bucket.lower}–{bucket.upper}
                </td>
                <td className="pr-3">{bucket.reviewed}</td>
                <td>{bucket.acceptance === null ? "—" : percent(bucket.acceptance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-[11px] text-[#94a3b8] dark:text-white/40">
        {lane.calibration.reason}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {lane.level === "watch" && (
          <button
            type="button"
            disabled={disabled || promoteBlocker !== null}
            title={promoteBlocker ?? undefined}
            onClick={() => onPromote({ laneId: lane.id, to: "suggest" })}
            className={`${BUTTON} bg-[#0d9488] text-white hover:bg-[#0f766e]`}
          >
            Promote to suggest
          </button>
        )}
        {lane.level === "suggest" && !promotingToAuto && (
          <button
            type="button"
            disabled={disabled || promoteBlocker !== null}
            title={promoteBlocker ?? undefined}
            onClick={() => setPromotingToAuto(true)}
            className={`${BUTTON} bg-[#0d9488] text-white hover:bg-[#0f766e]`}
          >
            Promote to auto
          </button>
        )}
        {lane.level !== "watch" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onDemote({ laneId: lane.id, to: lane.level === "auto" ? "suggest" : "watch" })
            }
            className={`${BUTTON} border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-white/60 hover:bg-[#f8fafc] dark:hover:bg-white/5`}
          >
            Demote to {lane.level === "auto" ? "suggest" : "watch"}
          </button>
        )}
        {promoteBlocker && lane.level !== "auto" && (
          <span className="text-[11px] text-[#94a3b8] dark:text-white/40">{promoteBlocker}</span>
        )}
      </div>

      {promotingToAuto && (
        <form onSubmit={submitAuto} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex flex-col">
            <label htmlFor={capId} className="text-[11px] text-[#64748b] dark:text-white/50">
              Amount cap
            </label>
            <input
              id={capId}
              inputMode="decimal"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
              disabled={disabled}
              className={INPUT}
            />
          </div>
          <div className="flex flex-col">
            <label htmlFor={thresholdId} className="text-[11px] text-[#64748b] dark:text-white/50">
              Confidence threshold
            </label>
            <input
              id={thresholdId}
              inputMode="decimal"
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              disabled={disabled}
              className={INPUT}
            />
          </div>
          <button
            type="submit"
            disabled={disabled || !cap.trim() || !threshold.trim()}
            className={`${BUTTON} bg-[#0d9488] text-white hover:bg-[#0f766e]`}
          >
            Let Jev approve
          </button>
          <button
            type="button"
            onClick={() => setPromotingToAuto(false)}
            className={`${BUTTON} text-[#64748b] dark:text-white/60`}
          >
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

export function JevLanesPanel({
  view,
  busy = false,
  error = null,
  onUpdateSettings,
  onPromote,
  onDemote,
}: JevLanesPanelProps) {
  const headingId = useId();
  const rateId = useId();
  const { settings, canConfigure } = view;
  const [rate, setRate] = useState(ratePercent(settings.spotCheckRate));
  const disabled = !canConfigure || busy;

  const saveRate = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    onUpdateSettings({ spotCheckRate: (Math.round(value * 100) / 10_000).toFixed(4) });
  };

  return (
    <section
      aria-labelledby={headingId}
      className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6"
    >
      <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
        Jev approval lanes
      </h3>
      <p className="text-xs text-[#64748b] dark:text-white/50 mb-4">
        Jev earns approval one vendor and one kind of paper at a time. A lane can be promoted only
        after 200 of Jev&apos;s own answers were reviewed with at least 98% accepted unchanged
        (remembered answers do not count toward it), and it drops back to suggest by itself if
        agreement over its last 50 papers, remembered ones included, falls below 95%. New vendors,
        changed bank details, duplicates, closed periods and open checks always go to a person.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-xs text-[#b91c1c] dark:text-red-300">
          {error}
        </p>
      )}
      {!canConfigure && (
        <p className="mb-4 text-xs font-medium text-[#94a3b8] dark:text-white/40">
          Only organization admins can change Jev approval.
        </p>
      )}

      <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-[#e2e8f0] dark:border-white/5 bg-[#f8fafc] dark:bg-[#0f172a] px-4 py-3">
        <div>
          <p className="text-sm font-medium text-[#1e293b] dark:text-white">
            Let Jev approve Inbox papers
          </p>
          <p className="text-[11px] text-[#94a3b8] dark:text-white/40">
            The organization&apos;s switch. Off, no lane approves anything; lanes keep learning.
          </p>
          {settings.walledKinds.length > 0 && (
            <p className="mt-1 text-[11px] text-[#b45309] dark:text-amber-300">
              Jev may not apply categories on its own yet, so nothing it approves is posted. Lanes
              still learn and can be promoted.
            </p>
          )}
          {settings.aiKillSwitch && (
            <p className="mt-1 text-[11px] text-[#b91c1c] dark:text-red-300">
              The AI kill switch is on: Jev approves nothing until it is off.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.autoApproveEnabled}
          aria-label="Let Jev approve Inbox papers"
          disabled={disabled}
          onClick={() => onUpdateSettings({ autoApproveEnabled: !settings.autoApproveEnabled })}
          className={`touch-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 disabled:cursor-not-allowed disabled:opacity-50 ${
            settings.autoApproveEnabled ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/10"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              settings.autoApproveEnabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      {settings.requireDifferentApprover && (
        <label className="mb-4 flex items-start gap-2.5 text-xs text-[#64748b] dark:text-white/60">
          <input
            type="checkbox"
            checked={settings.makerCheckerOptIn}
            disabled={disabled}
            onChange={(event) => onUpdateSettings({ makerCheckerOptIn: event.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-[#cbd5e1] text-[#0d9488] focus:ring-[#0d9488]/30"
          />
          <span>
            Let Jev approve even though this organization requires a different approver. Off,
            maker-checker keeps every approval with a person.
          </span>
        </label>
      )}

      <form onSubmit={saveRate} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label htmlFor={rateId} className="text-[11px] text-[#64748b] dark:text-white/50">
            Spot checks (% of papers Jev would approve, left for a person)
          </label>
          <input
            id={rateId}
            inputMode="decimal"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            disabled={disabled}
            className={INPUT}
          />
        </div>
        <button
          type="submit"
          disabled={disabled}
          className={`${BUTTON} bg-[#0d9488] text-white hover:bg-[#0f766e]`}
        >
          Save
        </button>
      </form>

      {view.lanes.length === 0 ? (
        <p className="text-xs text-[#94a3b8] dark:text-white/40">
          No lanes yet. A lane starts watching the first time Jev answers a paper.
        </p>
      ) : (
        <ul
          aria-label="Jev approval lanes"
          className="divide-y divide-[#e2e8f0] dark:divide-white/10"
        >
          {view.lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              canConfigure={canConfigure}
              busy={busy}
              onPromote={onPromote}
              onDemote={onDemote}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

/** The panel wired to the server functions, as the settings page mounts it. */
export function JevLanesSettings() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const lanes = useQuery({
    queryKey: keys.jev.lanes(),
    queryFn: () => callServerFn(listJevLanes, { data: undefined }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.jev.all() });
  const onError = (error: unknown) =>
    showToast(errorMessage(error) ?? "Something went wrong. Please try again.", { icon: "error" });

  const settings = useMutation({
    mutationFn: (patch: JevSettingsPatch) =>
      callServerFn(updateJevApprovalSettingsFn, { data: patch }),
    onSuccess: async () => {
      showToast("Jev approval settings saved.", { icon: "success" });
      await refresh();
    },
    onError,
  });
  const promote = useMutation({
    mutationFn: (promotion: JevPromotion) => callServerFn(promoteJevLane, { data: promotion }),
    onSuccess: async (result) => {
      showToast(`Lane promoted to ${result.level}.`, { icon: "success" });
      await refresh();
    },
    onError,
  });
  const demote = useMutation({
    mutationFn: (demotion: { laneId: string; to: "watch" | "suggest" }) =>
      callServerFn(demoteJevLane, { data: demotion }),
    onSuccess: async (result) => {
      showToast(`Lane demoted to ${result.level}.`, { icon: "success" });
      await refresh();
    },
    onError,
  });

  if (lanes.isPending) {
    return <p className="text-xs text-[#94a3b8] dark:text-white/40">Loading Jev approval…</p>;
  }
  if (lanes.isError || !lanes.data) {
    return (
      <p role="alert" className="text-xs text-[#b91c1c] dark:text-red-300">
        {errorMessage(lanes.error) ?? "Jev approval lanes could not be loaded."}
      </p>
    );
  }
  return (
    <JevLanesPanel
      view={lanes.data}
      busy={settings.isPending || promote.isPending || demote.isPending}
      error={errorMessage(settings.error ?? promote.error ?? demote.error)}
      onUpdateSettings={(patch) => settings.mutate(patch)}
      onPromote={(promotion) => promote.mutate(promotion)}
      onDemote={(demotion) => demote.mutate(demotion)}
    />
  );
}
