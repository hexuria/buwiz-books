/**
 * Who is posting.
 *
 * Every posting core takes an explicit actor instead of reading a session, so
 * the same domain code serves a signed-in user (server functions, Inbox
 * approval) and a system actor (Jev).
 *
 * Authorization is not decided here. A user's permissions are checked by the
 * server-function wrapper before a core runs. A system actor is authorized by
 * its autonomy lane (Inbox v2 step 11): only the Jev approval job, after every
 * approval check has passed, mints the grant a system actor must carry
 * (./system-approval-grant.ts). A system actor without one is refused
 * outright, and the cores that are not on the approval path refuse it even
 * with one.
 */
import { JEV_AUDIT_ACTOR_ID } from "@/lib/jev-actor";
import { isJevApprovalGrant, type JevApprovalGrant } from "./system-approval-grant";

export type PostingActor =
  | { type: "user"; userId: string }
  | { type: "system"; key: "jev"; grant?: JevApprovalGrant };

export class SystemActorNotSupportedError extends Error {
  constructor(
    readonly actorKey: string,
    readonly operation: string,
  ) {
    super(
      `${operation} cannot run as the system actor "${actorKey}": only a Jev approval that passed its autonomy lane's checks may post as a system actor.`,
    );
    this.name = "SystemActorNotSupportedError";
  }
}

/**
 * The user id a core stamps into user-typed audit columns, or a refusal. For
 * cores a system actor must never run: review-mode bills, editor-bill
 * accruals, invoices, bill submissions.
 */
export function requireUserActor(actor: PostingActor, operation: string): string {
  if (actor.type === "user") return actor.userId;
  throw new SystemActorNotSupportedError(actor.key, operation);
}

/**
 * The id a core on the approval path stamps into its free-text audit columns
 * (journal created_by, bill approver_id, activity actor): the user's id, or
 * JEV_AUDIT_ACTOR_ID for a system actor carrying a valid lane grant. Anything
 * else is refused.
 */
export function postingAuditActorId(actor: PostingActor, operation: string): string {
  if (actor.type === "user") return actor.userId;
  if (actor.key === "jev" && isJevApprovalGrant(actor.grant)) return JEV_AUDIT_ACTOR_ID;
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
