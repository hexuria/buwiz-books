import { ArrowClockwise, CreditCard } from "@phosphor-icons/react";

export function BillingReturnNotice({
  status,
  onDismiss,
}: {
  status: "success" | "cancelled";
  onDismiss: () => void;
}) {
  const succeeded = status === "success";
  return (
    <div
      className={`mb-6 flex items-start justify-between gap-4 rounded-xl border px-4 py-3 ${
        succeeded
          ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
          : "border-slate-200 bg-white text-slate-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-white/75"
      }`}
      role="status"
    >
      <div className="flex items-start gap-3">
        {succeeded ? (
          <ArrowClockwise size={20} weight="bold" className="mt-0.5 shrink-0 text-amber-700" />
        ) : (
          <CreditCard size={20} weight="duotone" className="mt-0.5 shrink-0" />
        )}
        <div>
          <p className="text-sm font-semibold">
            {succeeded ? "Checkout returned for verification" : "Checkout cancelled"}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed opacity-75">
            {succeeded
              ? "No subscription change is trusted yet. We are waiting for verified Stripe events before updating the allowance."
              : "No billing change was made. You can resume checkout from Billing."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      >
        Dismiss
      </button>
    </div>
  );
}
