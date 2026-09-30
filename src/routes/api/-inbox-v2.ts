/**
 * The Inbox list (spec §10).
 *
 * The reading pane uses the Inbox functions in `./-inbox` for everything else — getInboxItem for
 * detail, updateInboxCandidate for the editor's save, approveInbox and rejectInbox for decisions —
 * so the list adds no second write path.
 */
import { createServerFn } from "@tanstack/react-start";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import { withPermissionOrgContext } from "@/lib/server-context";

/** Everything that needs a human, with one reason per item. */
export const listInboxV2 = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("inbox", "view", ({ orgId, db }) => listInboxV2Items(db, orgId)),
);
