import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Retired page. Review rule configuration and the ledger scan now live in Settings -> Review
 * Rules, and findings are worked from the Inbox. The route stays only so old bookmarks and links
 * land somewhere useful instead of a 404.
 */
export const Route = createFileRoute("/review-agents")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", replace: true });
  },
});
