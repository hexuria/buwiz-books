/**
 * InboundEmailSettings — the organization's inbound email address (Settings → Email).
 *
 * Papers emailed or auto-forwarded to this address arrive in the Inbox through the organization's
 * inbound email routine. The card moved here from the classic Inbox's left rail when the new Inbox
 * became the only one; it saves through the same server functions the rail used
 * (src/routes/api/-inbox-settings.ts). Changing the address needs integration:authorize, which
 * those functions enforce; everyone else sees the address and can copy it.
 */
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";
import { usePermission } from "@/lib/use-permission";
import {
  generateInboundEmailAddress,
  getInboxSettings,
  updateInboxSettings,
} from "../../routes/api/-inbox-settings";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Please try again.";
}

export function InboundEmailSettings() {
  const headingId = useId();
  const inputId = useId();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canConfigure } = usePermission("integration", "authorize");
  const settingsQuery = useQuery({
    queryKey: keys.inbox.settings(),
    queryFn: () => callServerFn(getInboxSettings, { data: undefined }),
  });
  const savedAddress = settingsQuery.data?.inboundEmailAddress ?? null;
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setAddress(savedAddress ?? "");
  }, [savedAddress]);

  const save = useMutation({
    mutationFn: () => {
      const settings = settingsQuery.data;
      if (!settings) throw new Error("Inbox settings are still loading.");
      // The approval policy is not edited here; it is sent back exactly as loaded.
      return callServerFn(updateInboxSettings, {
        data: {
          inboundEmailAddress: address.trim() || null,
          requireDifferentApprover: settings.requireDifferentApprover,
          allowOwnerOverride: settings.allowOwnerOverride,
        },
      });
    },
    onSuccess: async () => {
      showToast("Inbound email address saved.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.settings() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  const generate = useMutation({
    mutationFn: () => callServerFn(generateInboundEmailAddress, { data: undefined }),
    onSuccess: async (result) => {
      if (result?.inboundEmailAddress) setAddress(result.inboundEmailAddress);
      showToast("Inbound address generated.", { icon: "success" });
      await queryClient.invalidateQueries({ queryKey: keys.inbox.settings() });
    },
    onError: (error) => showToast(errorMessage(error), { icon: "error" }),
  });

  const copy = () => {
    if (!savedAddress) return;
    void navigator.clipboard?.writeText(savedAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const unchanged = address.trim().toLowerCase() === (savedAddress ?? "");

  return (
    <section
      aria-labelledby={headingId}
      className="mt-6 bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-[#1e293b] dark:text-white">
          Inbound email
        </h3>
        <p className="mt-1 text-xs text-[#64748b] dark:text-white/50">
          Email or forward receipts, bills, and statements to this address. Each one arrives in the
          Inbox as a draft and stays out of the ledger until someone approves it.
        </p>
      </div>

      {canConfigure ? (
        <div className="space-y-3">
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-[#64748b] dark:text-white/50"
          >
            Inbound address
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={inputId}
              type="email"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="bills@inbound.example.com"
              className="min-w-0 flex-1 px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => save.mutate()}
                disabled={save.isPending || !settingsQuery.data || unchanged}
                className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#1e293b] dark:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 disabled:opacity-40 transition-all"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => generate.mutate()}
                disabled={generate.isPending}
                title="Generate a unique inbound address for this organization"
                className="px-4 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all"
              >
                {generate.isPending ? "Generating…" : "Generate"}
              </button>
              {savedAddress && (
                <button
                  type="button"
                  onClick={copy}
                  className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#0d9488] dark:text-teal-400 hover:bg-[#f0fdfa] dark:hover:bg-teal-900/20 transition-all"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 break-all text-sm text-[#1e293b] dark:text-white">
            {savedAddress ?? "Not configured"}
          </p>
          {savedAddress && (
            <button
              type="button"
              onClick={copy}
              className="shrink-0 text-xs font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-[#64748b] dark:text-white/50">
        Send them automatically with auto-forwarding:{" "}
        <a
          href="https://support.google.com/mail/answer/10957"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
        >
          Gmail
        </a>{" "}
        ·{" "}
        <a
          href="https://support.microsoft.com/office/turn-on-automatic-forwarding-in-outlook-7f2670a1-7fff-4475-8a3c-5822d63b0c8e"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[#0d9488] dark:text-teal-400 hover:underline"
        >
          Outlook
        </a>
        .
      </p>
    </section>
  );
}
