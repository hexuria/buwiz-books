export type GroupRole = "owner" | "admin" | "analyst" | "viewer";

const ROLE_ORDER: readonly GroupRole[] = ["owner", "admin", "analyst", "viewer"];
const ROLE_RANK: Record<GroupRole, number> = {
  owner: 4,
  admin: 3,
  analyst: 2,
  viewer: 1,
};

export function getPermittedMemberRoles(input: {
  currentRole: GroupRole;
  actorIsOwner: boolean;
  canMutate: boolean;
  canReduceAccess: boolean;
}): GroupRole[] {
  const visibleRoles = ROLE_ORDER.filter(
    (role) => role !== "owner" || input.actorIsOwner || input.currentRole === "owner",
  );
  if (input.canMutate) return [...visibleRoles];
  if (!input.canReduceAccess) return [input.currentRole];
  return visibleRoles.filter((role) => ROLE_RANK[role] <= ROLE_RANK[input.currentRole]);
}

export function canDemoteMember(input: {
  currentRole: GroupRole;
  actorIsOwner: boolean;
  canMutate: boolean;
  canReduceAccess: boolean;
}): boolean {
  return getPermittedMemberRoles(input).some(
    (role) => ROLE_RANK[role] < ROLE_RANK[input.currentRole],
  );
}
