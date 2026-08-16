/**
 * The shared empty state.
 *
 * Codifies the tinted-circle + light-stroke pattern that documents.tsx and reconciliations.tsx
 * already arrived at independently. The two sizes reproduce their metrics exactly, so retrofitting
 * either one later is a pure deletion with no visual diff.
 *
 * `tone` drives the tint through `currentColor` rather than the hardcoded `#10b981` both
 * originals use — that green is near-invisible against a dark background.
 */
import type { ReactNode } from "react";

export type EmptyStateTone = "neutral" | "success" | "error" | "info";

const TONE_CLASSES: Record<EmptyStateTone, string> = {
  neutral: "bg-slate-500/10 text-slate-400 dark:text-slate-500",
  success: "bg-emerald-500/10 text-emerald-500",
  error: "bg-rose-500/10 text-rose-500",
  info: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  size = "sm",
}: {
  /** Pass a sized icon, e.g. `<SearchIcon size={28} strokeWidth={1.5} />`. */
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: EmptyStateTone;
  size?: "sm" | "md";
}) {
  const md = size === "md";
  return (
    <div
      className={`flex w-full flex-col items-center justify-center text-center ${md ? "py-24" : "py-16"}`}
    >
      <div
        className={`flex items-center justify-center rounded-2xl ${TONE_CLASSES[tone]} ${
          md ? "mb-5 h-20 w-20" : "mb-4 h-14 w-14"
        }`}
      >
        {icon}
      </div>
      <h3
        className={`mb-1 font-semibold text-slate-800 dark:text-white ${md ? "text-lg" : "text-[15px]"}`}
      >
        {title}
      </h3>
      <p
        className={`leading-relaxed text-slate-500 dark:text-white/40 ${
          md ? "max-w-[420px] text-sm" : "max-w-[24rem] text-[13px]"
        }`}
      >
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
