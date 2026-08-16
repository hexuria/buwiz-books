import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FloppyDisk, Plus, Trash, UsersThree, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { keys } from "../../lib/query-keys";
import {
  archiveOrganizationGroup,
  deleteBusinessGroupMember,
  getBusinessGroupMemberCandidates,
  getBusinessGroupMembers,
  renameOrganizationGroup,
  upsertBusinessGroupMember,
} from "../../routes/api/-business-groups";
import { Modal } from "../ui/Modal";
import { canDemoteMember, getPermittedMemberRoles, type GroupRole } from "./member-role-controls";

interface ManagedGroup {
  id: string;
  name: string;
  status: string;
  role: GroupRole;
}

export function BusinessGroupAdminModal({
  group,
  open,
  canMutate,
  canReduceAccess,
  onClose,
  onChanged,
  onArchived,
}: {
  group: ManagedGroup;
  open: boolean;
  canMutate: boolean;
  canReduceAccess: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onArchived: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(group.name);
  const [candidateUserId, setCandidateUserId] = useState("");
  const [candidateRole, setCandidateRole] = useState<GroupRole>("viewer");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const isActive = group.status === "active";
  const editable = canMutate && isActive;

  useEffect(() => {
    if (!open) return;
    setName(group.name);
    setCandidateUserId("");
    setCandidateRole("viewer");
    setConfirmArchive(false);
  }, [group.id, group.name, open]);

  const members = useQuery({
    queryKey: keys.businessGroups.members(group.id),
    queryFn: () => getBusinessGroupMembers({ data: { groupId: group.id } }),
    enabled: open,
  });
  const candidates = useQuery({
    queryKey: keys.businessGroups.memberCandidates(group.id),
    queryFn: () => getBusinessGroupMemberCandidates({ data: { groupId: group.id } }),
    enabled: open,
  });
  const availableCandidates = useMemo(
    () => (candidates.data ?? []).filter((candidate) => candidate.groupRole === null),
    [candidates.data],
  );
  const ownerCount = (members.data ?? []).filter((member) => member.role === "owner").length;

  const refreshMembers = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.businessGroups.members(group.id) }),
      queryClient.invalidateQueries({
        queryKey: keys.businessGroups.memberCandidates(group.id),
      }),
      onChanged(),
    ]);
  };
  const renameMutation = useMutation({
    mutationFn: () => renameOrganizationGroup({ data: { groupId: group.id, name } }),
    onSuccess: onChanged,
  });
  const memberMutation = useMutation({
    mutationFn: (input: { targetUserId: string; role: GroupRole }) =>
      upsertBusinessGroupMember({ data: { groupId: group.id, ...input } }),
    onSuccess: async () => {
      setCandidateUserId("");
      setCandidateRole("viewer");
      await refreshMembers();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (targetUserId: string) =>
      deleteBusinessGroupMember({ data: { groupId: group.id, targetUserId } }),
    onSuccess: refreshMembers,
  });
  const archiveMutation = useMutation({
    mutationFn: () => archiveOrganizationGroup({ data: { groupId: group.id } }),
    onSuccess: onArchived,
  });
  const error =
    renameMutation.error ?? memberMutation.error ?? removeMutation.error ?? archiveMutation.error;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isActive ? "Manage Business Group" : "Archived Business Group"}
      description={
        isActive
          ? "Update the group and the people who can view or manage it."
          : "Archived groups remain available for audit history and membership review."
      }
      mobile="fullscreen"
      size="lg"
      closeOnBackdrop={false}
    >
      <div className="space-y-7 p-5 sm:p-6">
        <section>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Group details</h3>
          <form
            className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              renameMutation.mutate();
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-[11px] font-semibold text-slate-600 dark:text-white/55">
                Name
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={255}
                required
                disabled={!editable || renameMutation.isPending}
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              disabled={
                !editable ||
                renameMutation.isPending ||
                name.trim().length < 2 ||
                name.trim() === group.name
              }
              className={secondaryButtonClass}
            >
              <FloppyDisk size={16} weight="bold" />
              {renameMutation.isPending ? "Saving…" : "Save name"}
            </button>
          </form>
        </section>

        <section className="border-t border-slate-200 pt-6 dark:border-white/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Members</h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-white/45">
                Group access never replaces direct access to a business.
              </p>
            </div>
            <UsersThree size={22} weight="duotone" className="text-emerald-700" />
          </div>

          {!editable && canReduceAccess && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
              Group configuration is read-only. Authorized managers may still lower a member role or
              remove membership to complete a security cleanup; adding access and promotions remain
              blocked.
            </p>
          )}

          {members.isLoading ? (
            <div className="mt-4 h-28 animate-pulse rounded-xl bg-slate-100 dark:bg-white/[0.05]" />
          ) : members.isError ? (
            <InlineError message={errorMessage(members.error)} />
          ) : (
            <div className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-white/[0.06] dark:border-white/10">
              {(members.data ?? []).map((member) => {
                const finalOwner = member.role === "owner" && ownerCount === 1;
                const protectedOwner = member.role === "owner" && group.role !== "owner";
                const ownerActionBlocked = finalOwner || protectedOwner;
                const permittedRoles = getPermittedMemberRoles({
                  currentRole: member.role,
                  actorIsOwner: group.role === "owner",
                  canMutate: editable,
                  canReduceAccess,
                });
                const roleCanChange =
                  editable ||
                  canDemoteMember({
                    currentRole: member.role,
                    actorIsOwner: group.role === "owner",
                    canMutate: editable,
                    canReduceAccess,
                  });
                return (
                  <div
                    key={member.userId}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                        {member.name}
                      </p>
                      <p className="truncate text-xs text-slate-500 dark:text-white/40">
                        {member.email}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        disabled={!roleCanChange || memberMutation.isPending || ownerActionBlocked}
                        onChange={(event) =>
                          memberMutation.mutate({
                            targetUserId: member.userId,
                            role: event.target.value as GroupRole,
                          })
                        }
                        className={selectClass}
                      >
                        {permittedRoles.map((role) => (
                          <option key={role} value={role}>
                            {roleLabel(role)}
                          </option>
                        ))}
                      </select>
                      {(editable || canReduceAccess) && (
                        <button
                          type="button"
                          aria-label={`Remove ${member.name}`}
                          title={
                            finalOwner
                              ? "A Business Group must keep an owner"
                              : protectedOwner
                                ? "Only an owner can remove another owner"
                                : undefined
                          }
                          disabled={removeMutation.isPending || ownerActionBlocked}
                          onClick={() => removeMutation.mutate(member.userId)}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-rose-400/10 dark:hover:text-rose-300"
                        >
                          <Trash size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {editable && availableCandidates.length > 0 && (
            <form
              className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-4 dark:bg-white/[0.035] sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                if (!candidateUserId) return;
                memberMutation.mutate({ targetUserId: candidateUserId, role: candidateRole });
              }}
            >
              <label>
                <span className={labelClass}>Enterprise member</span>
                <select
                  value={candidateUserId}
                  onChange={(event) => setCandidateUserId(event.target.value)}
                  disabled={memberMutation.isPending}
                  className={selectClass}
                >
                  <option value="">Choose a member</option>
                  {availableCandidates.map((candidate) => (
                    <option key={candidate.userId} value={candidate.userId}>
                      {candidate.name} — {candidate.email}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelClass}>Role</span>
                <select
                  value={candidateRole}
                  onChange={(event) => setCandidateRole(event.target.value as GroupRole)}
                  disabled={memberMutation.isPending}
                  className={selectClass}
                >
                  {group.role === "owner" && <option value="owner">Owner</option>}
                  <option value="admin">Admin</option>
                  <option value="analyst">Analyst</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={!candidateUserId || memberMutation.isPending}
                className={secondaryButtonClass}
              >
                <Plus size={16} weight="bold" /> Add
              </button>
            </form>
          )}
        </section>

        {error && <InlineError message={errorMessage(error)} />}

        {editable && (
          <section className="border-t border-slate-200 pt-6 dark:border-white/10">
            <h3 className="text-sm font-semibold text-rose-800 dark:text-rose-300">
              Archive group
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500 dark:text-white/45">
              Archiving disables every linked business and releases those assignments. Members and
              audit history remain. Restoring later creates an empty active group.
            </p>
            {confirmArchive ? (
              <div className="mt-4 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-400/20 dark:bg-rose-400/10 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2 text-sm text-rose-950 dark:text-rose-100">
                  <WarningCircle size={19} weight="fill" className="mt-0.5 shrink-0" />
                  <span>Archive {group.name} and unlink all of its businesses?</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmArchive(false)}
                    disabled={archiveMutation.isPending}
                    className={quietButtonClass}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => archiveMutation.mutate()}
                    disabled={archiveMutation.isPending}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white transition hover:bg-rose-800 disabled:opacity-45"
                  >
                    <Archive size={16} weight="bold" />
                    {archiveMutation.isPending ? "Archiving…" : "Archive"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmArchive(true)}
                className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border border-rose-200 px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 dark:border-rose-400/25 dark:text-rose-300 dark:hover:bg-rose-400/10"
              >
                <Archive size={16} /> Archive Business Group
              </button>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:bg-rose-400/10 dark:text-rose-300">
      {message}
    </p>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function roleLabel(role: GroupRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const labelClass = "mb-1.5 block text-[11px] font-semibold text-slate-600 dark:text-white/55";
const inputClass =
  "min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-base text-slate-900 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 disabled:opacity-50 sm:text-sm dark:border-white/10 dark:bg-[#0e141c] dark:text-white";
const selectClass =
  "min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 disabled:opacity-50 dark:border-white/10 dark:bg-[#0e141c] dark:text-white";
const secondaryButtonClass =
  "inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-700 dark:hover:bg-emerald-600";
const quietButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-45 dark:border-white/10 dark:bg-white/[0.04] dark:text-white/70";
