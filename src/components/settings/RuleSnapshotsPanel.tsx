/**
 * Rule snapshots — the last card of Settings → Review Rules (Inbox v2 spec §6, §10).
 *
 * The flow it supports: freeze the current rules into a snapshot, measure it
 * with `bun eval:scorecard`, shadow it on a routine, then pin it to promote.
 * Older snapshots stay listed for rollback. Snapshots cannot be edited.
 *
 * `RuleSnapshotsPanel` is presentational; `RuleSnapshotsSettings` wires it to
 * the server functions and is what ReviewRulesSettings mounts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { useToast } from "@/components/ui/Toast";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import {
  createRuleSnapshot,
  listRuleSnapshots,
  pinRoutineRuleSnapshot,
  unpinRoutineRuleSnapshot,
} from "@/routes/api/-rule-snapshots";
import { listRoutines } from "@/routes/api/-routines";

export interface RuleSnapshotRow {
  id: string;
  label: string | null;
  createdAt: Date | string;
  ruleCount: number;
  pinnedBy: Array<{ routineId: string; routineName: string; slot: "active" | "shadow" }>;
}

export interface RoutineRuleRow {
  id: string;
  name: string;
  ruleSnapshotId: string | null;
  shadowRuleSnapshotId: string | null;
}

export interface RulePinChange {
  routineId: string;
  snapshotId: string | null;
  shadow: boolean;
}

export interface RuleSnapshotsPanelProps {
  snapshots: RuleSnapshotRow[];
  routines: RoutineRuleRow[];
  canConfigure: boolean;
  busy?: boolean;
  error?: string | null;
  onCreate: (label: string) => void;
  onPin: (change: RulePinChange) => void;
}

const SELECT =
  "min-h-11 lg:min-h-0 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] px-2 py-1.5 text-xs text-[#1e293b] dark:text-white disabled:opacity-50";

function snapshotName(snapshot: Pick<RuleSnapshotRow, "label">): string {
  return snapshot.label?.trim() || "Untitled snapshot";
}

function createdOn(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function RuleSnapshotsPanel({
  snapshots,
  routines,
  canConfigure,
  busy = false,
  error = null,
  onCreate,
  onPin,
}: RuleSnapshotsPanelProps) {
  const headingId = useId();
  const labelId = useId();
  const [label, setLabel] = useState("");
  const disabled = !canConfigure || busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate(label.trim());
    setLabel("");
  };

  return (
    <section
      aria-labelledby={headingId}
      className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6"
    >
      <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">
        Rule snapshots
      </h3>
      <p className="text-xs text-[#64748b] dark:text-white/50 mb-4">
        A snapshot freezes the rules above exactly as they are now. Shadow one on a routine to see
        what it would flag without holding anything back, then choose it as the routine&apos;s
        rules. Older snapshots stay here, so you can switch back.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-xs text-[#b91c1c] dark:text-red-300">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          <label htmlFor={labelId} className="text-[11px] text-[#64748b] dark:text-white/50">
            Snapshot label
          </label>
          <input
            id={labelId}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={120}
            placeholder="e.g. Receipts over 50"
            disabled={disabled}
            className="mt-1 min-h-11 lg:min-h-0 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] px-3 py-1.5 text-sm text-[#1e293b] dark:text-white disabled:opacity-50"
          />
        </div>
        <button
          type="submit"
          disabled={disabled}
          className="min-h-11 lg:min-h-0 rounded-lg bg-[#0d9488] px-4 py-2 text-sm font-medium text-white transition-all hover:bg-[#0f766e] disabled:opacity-50"
        >
          Snapshot current rules
        </button>
      </form>

      {snapshots.length === 0 ? (
        <p className="text-xs text-[#94a3b8] dark:text-white/40">
          No snapshots yet. Routines use the live rules.
        </p>
      ) : (
        <ul
          aria-label="Saved rule snapshots"
          className="divide-y divide-[#e2e8f0] dark:divide-white/10"
        >
          {snapshots.map((snapshot) => (
            <li key={snapshot.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-medium text-[#1e293b] dark:text-white">
                {snapshotName(snapshot)}
              </span>
              <span className="text-[11px] text-[#94a3b8] dark:text-white/40">
                {createdOn(snapshot.createdAt)} · {snapshot.ruleCount} rules
              </span>
              {snapshot.pinnedBy.map((pin) => (
                <span
                  key={`${pin.routineId}:${pin.slot}`}
                  className="rounded-full bg-[#f1f5f9] dark:bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-[#64748b] dark:text-white/50"
                >
                  {pin.slot === "active" ? "Pinned on" : "Shadowing"} {pin.routineName}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {routines.length === 0 ? (
        <p className="mt-4 text-xs text-[#94a3b8] dark:text-white/40">
          No routines yet. Inbound email becomes one when the first email arrives.
        </p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <caption className="sr-only">Rules each routine uses</caption>
          <thead>
            <tr className="text-[11px] text-[#64748b] dark:text-white/50">
              <th scope="col" className="py-1 font-medium">
                Routine
              </th>
              <th scope="col" className="py-1 font-medium">
                Rules
              </th>
              <th scope="col" className="py-1 font-medium">
                Shadow
              </th>
            </tr>
          </thead>
          <tbody>
            {routines.map((routine) => (
              <tr key={routine.id}>
                <td className="py-1 pr-2 text-[#1e293b] dark:text-white">{routine.name}</td>
                <td className="py-1 pr-2">
                  <select
                    aria-label={`Rules for ${routine.name}`}
                    value={routine.ruleSnapshotId ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      onPin({
                        routineId: routine.id,
                        snapshotId: event.target.value || null,
                        shadow: false,
                      })
                    }
                    className={SELECT}
                  >
                    <option value="">Live rules</option>
                    {snapshots.map((snapshot) => (
                      <option key={snapshot.id} value={snapshot.id}>
                        {snapshotName(snapshot)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1">
                  <select
                    aria-label={`Shadow for ${routine.name}`}
                    value={routine.shadowRuleSnapshotId ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      onPin({
                        routineId: routine.id,
                        snapshotId: event.target.value || null,
                        shadow: true,
                      })
                    }
                    className={SELECT}
                  >
                    <option value="">No shadow</option>
                    {snapshots
                      .filter((snapshot) => snapshot.id !== routine.ruleSnapshotId)
                      .map((snapshot) => (
                        <option key={snapshot.id} value={snapshot.id}>
                          {snapshotName(snapshot)}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

/** The panel wired to the server functions, as Settings → Review Rules mounts it. */
export function RuleSnapshotsSettings() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canConfigure } = usePermission("agentRule", "configure");
  const snapshots = useQuery({
    queryKey: keys.ruleSnapshots.list(),
    queryFn: () => callServerFn(listRuleSnapshots, { data: undefined }),
  });
  const routines = useQuery({
    queryKey: keys.routines.list(),
    queryFn: () => callServerFn(listRoutines, { data: undefined }),
  });
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.ruleSnapshots.all() }),
      queryClient.invalidateQueries({ queryKey: keys.routines.all() }),
    ]);
  };
  const onError = (error: unknown) =>
    showToast(errorMessage(error) ?? "That did not save. Please try again.", { icon: "error" });
  const create = useMutation({
    mutationFn: (label: string) =>
      callServerFn(createRuleSnapshot, { data: { label: label || undefined } }),
    onSuccess: async (snapshot) => {
      await invalidate();
      showToast(`Snapshot “${snapshotName(snapshot)}” saved.`, { icon: "success" });
    },
    onError,
  });
  const pin = useMutation({
    mutationFn: (change: RulePinChange) =>
      change.snapshotId
        ? callServerFn(pinRoutineRuleSnapshot, {
            data: {
              routineId: change.routineId,
              snapshotId: change.snapshotId,
              shadow: change.shadow,
            },
          })
        : callServerFn(unpinRoutineRuleSnapshot, {
            data: { routineId: change.routineId, shadow: change.shadow },
          }),
    onSuccess: async (routine) => {
      await invalidate();
      showToast(`${routine.name} rules updated.`, { icon: "success" });
    },
    onError,
  });

  return (
    <RuleSnapshotsPanel
      snapshots={snapshots.data ?? []}
      routines={routines.data ?? []}
      canConfigure={canConfigure}
      busy={create.isPending || pin.isPending}
      error={errorMessage(snapshots.error) ?? errorMessage(routines.error)}
      onCreate={(label) => create.mutate(label)}
      onPin={(change) => pin.mutate(change)}
    />
  );
}
