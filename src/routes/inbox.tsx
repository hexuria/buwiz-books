import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AppErrorBoundary } from "@/components/error/AppErrorBoundary";
import { InboxV2Page } from "@/components/inbox-v2/InboxV2Page";

type InboxSearch = {
  /** The item open in the reading pane. */
  selected?: string;
};

/**
 * The Inbox: one list of what needs a person, each item with one reason, and a reading pane with
 * the editor the item posts through (src/components/inbox-v2, spec §10).
 *
 * This is the only Inbox. The classic three-pane page and the per-organization `inbox_v2` switch
 * that chose between the two are gone (spec §11 cutover). An `inboxV2` key left in an
 * organization's metadata is ignored, and an old link's `?state=` filter simply lands here.
 */
export const Route = createFileRoute("/inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    selected: typeof search.selected === "string" ? search.selected : undefined,
  }),
  component: InboxRoute,
});

function InboxRoute() {
  return (
    <AppErrorBoundary contextLabel="Inbox">
      <InboxScreen />
    </AppErrorBoundary>
  );
}

function InboxScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <InboxV2Page
      selectedId={search.selected}
      onSelect={(id, options) =>
        navigate({
          search: (previous) => ({ ...previous, selected: id }),
          replace: options?.replace,
        })
      }
    />
  );
}
