/**
 * How Jev, the system approver, appears in audit columns (Inbox v2 §2).
 *
 * Client-safe: the Bills and Transactions screens read it to tag entries Jev
 * approved. The representation, decided once for step 11:
 *
 *   - review_decisions: actor_type 'system', actor_key 'jev', actor_id NULL
 *     (migration 0053). This is the authoritative record of who approved.
 *   - User FOREIGN KEY columns never borrow a user and never hold a sentinel:
 *     inbox_items.resolved_by stays NULL on a Jev approval (resolved_at and a
 *     resolution note still say when and by what), and submitted_by keeps
 *     whoever submitted the paper.
 *   - Free-text audit columns that record "who" with no foreign key —
 *     journal_headers.created_by, bills.approver_id, activity_logs.actor_id,
 *     workflow_events.actor_id — carry JEV_AUDIT_ACTOR_ID, following the
 *     existing `system` convention for background writers, so every row a Jev
 *     approval writes names Jev rather than nobody.
 */
export const JEV_AUDIT_ACTOR_ID = "system:jev";

export function isJevAuditActor(actorId: string | null | undefined): boolean {
  return actorId === JEV_AUDIT_ACTOR_ID;
}
