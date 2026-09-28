import { EmptyState } from "@/components/ui/EmptyState";
import { ClipboardCheckIcon } from "@/components/ui/icons";

/**
 * What Settings -> Review Rules shows when `review_rule_definitions` is empty.
 *
 * This is the state the page shipped in for as long as the catalog went unseeded, and the copy is
 * the whole point of it: the previous version said only "No review agents are configured.", which
 * told an administrator nothing about what was missing, what it cost them, or who could fix it.
 *
 * It replaces the whole rule list rather than sitting beside it — on the retired Review Agents
 * page, a 320px empty rail beside the words "no agents" was the original absurdity.
 *
 * Lives in its own module so it can be rendered in a test without pulling server functions into
 * jsdom.
 */
export function EmptyCatalogNotice({ onReload }: { onReload: () => void }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <EmptyState
        size="md"
        tone="info"
        // The nav glyph, so the page confirms it is the one that was clicked.
        icon={<ClipboardCheckIcon size={36} strokeWidth={1.5} />}
        title="No review agents are set up yet"
        description="Review agents come from a shared catalogue that hasn't been loaded into this workspace. Until it is, nothing checks your books automatically and no findings can be raised. Ask your administrator to run the review-agent catalogue setup, then reload this page."
        action={
          <button
            type="button"
            onClick={onReload}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800"
          >
            Reload
          </button>
        }
      />
    </div>
  );
}
