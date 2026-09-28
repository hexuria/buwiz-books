/**
 * Routine server functions (Inbox v2 spec §3).
 *
 * The auth + rate-limit + org-scope shell around src/lib/routines/service.ts,
 * which holds the logic so it stays testable without a request. Routines
 * decide what flows into the books automatically, so every write needs
 * integration:authorize — the same grant as configuring the inbound address.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  createRoutine as createRoutineRow,
  createRoutineInputSchema,
  listRoutines as listRoutineRows,
  rotateRoutineWebhookSecret as rotateRoutineWebhookSecretRow,
  routineIdInputSchema,
  setRoutineEnabled,
  updateRoutine as updateRoutineRow,
  updateRoutineInputSchema,
} from "@/lib/routines/service";
import { withMutationPermissionOrgContext, withPermissionOrgContext } from "@/lib/server-context";

export const listRoutines = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("integration", "view", async ({ orgId, db }) =>
    listRoutineRows(db, orgId),
  ),
);

export const createRoutine = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createRoutineInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "integration",
      "authorize",
      { routeKey: "routines:create", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        createRoutineRow(db, { orgId, actorId: userId, routine: data }),
    ),
  );

export const updateRoutine = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateRoutineInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "integration",
      "authorize",
      { routeKey: "routines:update", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        updateRoutineRow(db, { orgId, actorId: userId, update: data }),
    ),
  );

export const enableRoutine = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => routineIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "integration",
      "authorize",
      { routeKey: "routines:enable", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        setRoutineEnabled(db, { orgId, actorId: userId, routineId: data.routineId, enabled: true }),
    ),
  );

export const disableRoutine = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => routineIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "integration",
      "authorize",
      { routeKey: "routines:disable", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        setRoutineEnabled(db, {
          orgId,
          actorId: userId,
          routineId: data.routineId,
          enabled: false,
        }),
    ),
  );

/**
 * Generate (or rotate) a webhook routine's signing secret. The response is
 * the only place the plaintext secret ever appears — it cannot be read back.
 */
export const rotateRoutineWebhookSecret = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => routineIdInputSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "integration",
      "authorize",
      { routeKey: "routines:rotate-secret", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) =>
        rotateRoutineWebhookSecretRow(db, { orgId, actorId: userId, routineId: data.routineId }),
    ),
  );
