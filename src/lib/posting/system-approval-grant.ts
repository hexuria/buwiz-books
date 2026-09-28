/**
 * The only thing that lets a posting core run as Jev.
 *
 * A system actor is authorized by its autonomy lane, not by a role (spec §1).
 * The Jev approval job (src/lib/inbox/jev-approval/auto-approve.ts) mints one
 * grant per paper, under the candidate's lifecycle lock, AFTER every approval
 * check has passed; the posting cores accept a system actor only when it
 * carries a grant minted here. A look-alike object is not a grant: validity is
 * membership in this module's private registry, so no other path can
 * construct one by accident. The wiring test pins that the job is the only
 * caller of mintJevApprovalGrant.
 */

export interface JevApprovalGrant {
  readonly kind: "jev_lane_approval";
  readonly laneId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly confidence: number;
}

const issued = new WeakSet<JevApprovalGrant>();

export function mintJevApprovalGrant(input: Omit<JevApprovalGrant, "kind">): JevApprovalGrant {
  const grant: JevApprovalGrant = Object.freeze({ kind: "jev_lane_approval", ...input });
  issued.add(grant);
  return grant;
}

export function isJevApprovalGrant(value: unknown): value is JevApprovalGrant {
  return typeof value === "object" && value !== null && issued.has(value as JevApprovalGrant);
}
