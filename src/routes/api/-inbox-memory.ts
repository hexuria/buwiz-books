/**
 * Classification memory server functions (Inbox v2 spec §7).
 *
 * The auth + rate-limit + org-scope shell around src/lib/inbox/memory/service.ts,
 * which holds the logic so it stays testable without a request.
 *
 * Permissions:
 *   • saving ("Remember this?") and its scope preview need inbox:approve — the
 *     roles that can post an Inbox paper to the books. A memory that would
 *     answer more than one party's papers (these words; a sender without a
 *     party) additionally needs agentRule:configure, checked in the service;
 *   • listing needs inbox:view;
 *   • turning memories on or off, and deleting them, need agentRule:configure —
 *     memories are organization configuration, like the review rules.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  deleteMemory as deleteMemoryRow,
  listMemories as listMemoryRows,
  memoryIdInputSchema,
  previewMemoryScope as previewMemoryScopeRows,
  previewMemoryScopeInputSchema,
  rememberCorrection as rememberCorrectionRow,
  rememberCorrectionInputSchema,
  setMemoryEnabled,
} from "@/lib/inbox/memory/service";
import { withMutationPermissionOrgContext, withPermissionOrgContext } from "@/lib/server-context";

export const rememberCorrection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => rememberCorrectionInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "inbox",
      "approve",
      { routeKey: "inbox:remember-correction", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) =>
        rememberCorrectionRow({ db, orgId, userId, role }, data),
    ),
  );

export const previewMemoryScope = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => previewMemoryScopeInputSchema.parse(input))
  .handler(async ({ data }) =>
    withPermissionOrgContext("inbox", "approve", async ({ orgId, role, db }) =>
      previewMemoryScopeRows({ db, orgId, role }, data),
    ),
  );

export const listMemories = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("inbox", "view", async ({ orgId, db }) => listMemoryRows(db, orgId)),
);

export const enableMemory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => memoryIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "inbox:memory-enable", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) =>
        setMemoryEnabled({ db, orgId, userId, role }, { memoryId: data.memoryId, enabled: true }),
    ),
  );

export const disableMemory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => memoryIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "inbox:memory-disable", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) =>
        setMemoryEnabled({ db, orgId, userId, role }, { memoryId: data.memoryId, enabled: false }),
    ),
  );

export const deleteMemory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => memoryIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "inbox:memory-delete", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) =>
        deleteMemoryRow({ db, orgId, userId, role }, { memoryId: data.memoryId }),
    ),
  );
