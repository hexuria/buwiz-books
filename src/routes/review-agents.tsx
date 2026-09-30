import { createFileRoute, redirect } from "@tanstack/react-router";

type LegacySearch = {
  /** The rule an old Inbox "Agent settings" link pointed at. */
  agent?: string;
};

/**
 * Retired page. Review rule configuration and the ledger scan now live in Settings -> Review
 * Rules, and findings are worked from the Inbox. The route stays only so old bookmarks and links
 * land somewhere useful instead of a 404.
 *
 * The Inbox used to link every finding to `/review-agents?agent=<rule>`, so those links go to that
 * rule in the active organization's Settings. The organization id comes from the session the root
 * route already resolved; without one, or without a rule, the visitor lands on the Inbox.
 */
export const Route = createFileRoute("/review-agents")({
  validateSearch: (search: Record<string, unknown>): LegacySearch => ({
    agent:
      typeof search.agent === "string" && search.agent.length > 0 && search.agent.length <= 64
        ? search.agent
        : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    const orgId = context.routeAuth?.activeOrganizationId;
    if (search.agent && orgId) {
      throw redirect({
        to: "/organization/$orgId/settings",
        params: { orgId },
        search: { section: "review-rules", rule: search.agent },
        replace: true,
      });
    }
    throw redirect({ to: "/inbox", replace: true });
  },
});
