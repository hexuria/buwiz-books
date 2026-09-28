/**
 * Settings → General: the organization's `inbox_v2` switch. Admin-only, like every other
 * organization-wide setting; it changes what /inbox shows for every member. Both Inboxes read the
 * same items, so turning it on or off moves nothing.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateOrgInboxV2Setting } from "@/routes/api/-org-settings";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { useRole } from "@/lib/use-permission";
import { useToast } from "../ui/Toast";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function InboxV2Setting({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { role } = useRole();
  const isAdmin = role === "admin" || role === "owner";

  const mutation = useMutation({
    // The server function parses its own input, so its declared input type is `undefined`.
    mutationFn: (next: boolean) =>
      callServerFn(
        updateOrgInboxV2Setting as (opts: {
          data: unknown;
        }) => Promise<{ success: boolean; enabled: boolean }>,
        { data: { organizationId: orgId, enabled: next } },
      ),
    onSuccess: async (result) => {
      showToast(
        result.enabled
          ? "The new Inbox is on for everyone in this organization."
          : "Everyone is back on the classic Inbox.",
        { icon: "success" },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.org.settings() }),
        queryClient.invalidateQueries({ queryKey: keys.inbox.all() }),
      ]);
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  return (
    <section className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white mb-1">New Inbox</h3>
          <p className="text-xs text-[#64748b] dark:text-white/50">
            Shows only what needs a person, each paper open in the Bills or New transaction editor,
            with keyboard review (j / k to move, a to approve, r to reject). Both Inboxes read the
            same items, so you can switch back at any time.
          </p>
          {!isAdmin && (
            <p className="mt-2 text-xs font-medium text-[#94a3b8] dark:text-white/40">
              Only organization admins can change this.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="New Inbox"
          disabled={!isAdmin || mutation.isPending}
          onClick={() => mutation.mutate(!enabled)}
          className={`touch-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 disabled:cursor-not-allowed disabled:opacity-50 ${
            enabled ? "bg-[#0d9488]" : "bg-[#e2e8f0] dark:bg-white/10"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </section>
  );
}
