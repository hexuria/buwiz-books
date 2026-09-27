/**
 * Rule snapshots panel (Inbox v2 spec §6, §10 "Settings: Rules … snapshots").
 *
 * Standalone on purpose: the Settings → Review Rules page lives on another
 * build step's branch and mounts `RuleSnapshotsSettings` when both land. This
 * file owns no route.
 *
 * The flow it supports: freeze the current rules into a snapshot, measure it
 * with `bun eval:scorecard`, shadow it on a routine, then pin it to promote.
 * Older snapshots stay listed for rollback. Snapshots cannot be edited.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
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
  const [label, setLabel] = useState("");
  const disabled = !canConfigure || busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate(label.trim());
    setLabel("");
  };

  return (
    <section aria-labelledby="rule-snapshots-heading" className="space-y-4">
      <div>
        <h2 id="rule-snapshots-heading" className="text-base font-semibold">
          Rule snapshots
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          A snapshot freezes today&apos;s rules. Shadow it on a routine to see what it would flag,
          then pin it to make it the routine&apos;s rules. Older snapshots stay for rollback.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="text-slate-600 dark:text-slate-300">Snapshot label</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={120}
            placeholder="e.g. Receipts over 50"
            disabled={disabled}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
          />
        </label>
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Snapshot current rules
        </button>
      </form>

      {snapshots.length === 0 ? (
        <p className="text-sm text-slate-500">No snapshots yet. Routines use the live rules.</p>
      ) : (
        <ul aria-label="Rule snapshots" className="divide-y divide-slate-200 dark:divide-slate-700">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id} className="py-2 text-sm">
              <span className="font-medium">{snapshotName(snapshot)}</span>
              <span className="ml-2 text-slate-500">
                {createdOn(snapshot.createdAt)} · {snapshot.ruleCount} rules
              </span>
              {snapshot.pinnedBy.map((pin) => (
                <span
                  key={`${pin.routineId}:${pin.slot}`}
                  className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  {pin.slot === "active" ? "Pinned on" : "Shadowing"} {pin.routineName}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {routines.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Rules each routine uses</caption>
          <thead>
            <tr className="text-slate-500">
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
                <td className="py-1 pr-2">{routine.name}</td>
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
                    className="rounded-md border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
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
                    className="rounded-md border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
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

/** The panel wired to the server functions. Mount this from Settings → Review Rules. */
export function RuleSnapshotsSettings() {
  const queryClient = useQueryClient();
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
  const create = useMutation({
    mutationFn: (label: string) =>
      callServerFn(createRuleSnapshot, { data: { label: label || undefined } }),
    onSuccess: invalidate,
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
    onSuccess: invalidate,
  });
  const failure = create.error ?? pin.error ?? snapshots.error ?? routines.error;

  return (
    <RuleSnapshotsPanel
      snapshots={snapshots.data ?? []}
      routines={routines.data ?? []}
      canConfigure={canConfigure}
      busy={create.isPending || pin.isPending}
      error={failure instanceof Error ? failure.message : null}
      onCreate={(label) => create.mutate(label)}
      onPin={(change) => pin.mutate(change)}
    />
  );
}
