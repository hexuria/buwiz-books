/**
 * Who is posting.
 *
 * Every posting core takes an explicit actor instead of reading a session, so
 * the same domain code serves a signed-in user (server functions, Inbox
 * approval) and, later, a system actor (Jev).
 *
 * Authorization is not decided here. A user's permissions are checked by the
 * server-function wrapper before a core runs. A system actor is authorized by
 * its autonomy lane (Inbox v2 step 11), and until that lane exists nothing can
 * authorize one, so the cores refuse a system actor outright instead of
 * guessing how to record it.
 */
export type PostingActor = { type: "user"; userId: string } | { type: "system"; key: "jev" };

export class SystemActorNotSupportedError extends Error {
  constructor(
    readonly actorKey: string,
    readonly operation: string,
  ) {
    super(
      `${operation} cannot run as the system actor "${actorKey}" yet: system approvals need an autonomy lane, which is not wired up.`,
    );
    this.name = "SystemActorNotSupportedError";
  }
}

/** The user id a core stamps into user-typed audit columns, or a refusal. */
export function requireUserActor(actor: PostingActor, operation: string): string {
  if (actor.type === "user") return actor.userId;
  throw new SystemActorNotSupportedError(actor.key, operation);
}

/** The review_decisions actor columns (0053) for one actor. */
export function reviewDecisionActor(actor: PostingActor): {
  actorType: "user" | "system";
  actorId: string | null;
  actorKey: string | null;
} {
  return actor.type === "user"
    ? { actorType: "user", actorId: actor.userId, actorKey: null }
    : { actorType: "system", actorId: null, actorKey: actor.key };
}
