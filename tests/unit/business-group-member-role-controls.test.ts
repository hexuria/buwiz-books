import { describe, expect, it } from "vitest";
import {
  canDemoteMember,
  getPermittedMemberRoles,
} from "../../src/components/business-groups/member-role-controls";

describe("Business Group member role controls", () => {
  it("offers only the current role and demotions during read-only cleanup", () => {
    expect(
      getPermittedMemberRoles({
        currentRole: "admin",
        actorIsOwner: true,
        canMutate: false,
        canReduceAccess: true,
      }),
    ).toEqual(["admin", "analyst", "viewer"]);
    expect(
      getPermittedMemberRoles({
        currentRole: "viewer",
        actorIsOwner: true,
        canMutate: false,
        canReduceAccess: true,
      }),
    ).toEqual(["viewer"]);
  });

  it("does not expose owner promotion to an admin or any change without cleanup authority", () => {
    expect(
      getPermittedMemberRoles({
        currentRole: "analyst",
        actorIsOwner: false,
        canMutate: true,
        canReduceAccess: true,
      }),
    ).toEqual(["admin", "analyst", "viewer"]);
    expect(
      canDemoteMember({
        currentRole: "admin",
        actorIsOwner: true,
        canMutate: false,
        canReduceAccess: false,
      }),
    ).toBe(false);
  });
});
