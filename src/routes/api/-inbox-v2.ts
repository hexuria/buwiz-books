/**
 * Inbox v2 server functions (spec §10-11).
 *
 * The reading pane reuses the classic Inbox functions in `./-inbox` for everything else —
 * getInboxItem for detail, updateInboxCandidate for the editor's save, approveInbox and
 * rejectInbox for decisions — so the new screen adds no second write path.
 */
import { createServerFn } from "@tanstack/react-start";
import { readInboxV2Enabled } from "@/lib/inbox/v2/flag";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import { withPermissionOrgContext, withSessionOrgContext } from "@/lib/server-context";

/** Whether this organization sees the new Inbox. Any member may ask: it picks the page. */
export const getInboxV2Enabled = createServerFn({ method: "GET" }).handler(async () =>
  withSessionOrgContext(async ({ orgId, db }) => ({
    enabled: await readInboxV2Enabled(db, orgId),
  })),
);

/** Everything that needs a human, with one reason per item. */
export const listInboxV2 = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("inbox", "view", ({ orgId, db }) => listInboxV2Items(db, orgId)),
);
