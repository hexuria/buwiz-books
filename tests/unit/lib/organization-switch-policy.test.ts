import { describe, expect, it } from "vitest";
import {
  decideOrganizationSwitch,
  isPlatformOperatorEmail,
} from "../../../src/lib/organization-switch-policy";

describe("organization switch policy", () => {
  it("denies a non-member that is not the configured platform operator", () => {
    expect(
      decideOrganizationSwitch({
        hasExistingMembership: false,
        actorEmail: "tenant-admin@example.com",
        configuredOperatorEmail: "operator@example.com",
      }),
    ).toBe("denied");
  });

  it("fails closed when either operator email is missing", () => {
    expect(isPlatformOperatorEmail("operator@example.com", undefined)).toBe(false);
    expect(isPlatformOperatorEmail(undefined, "operator@example.com")).toBe(false);
    expect(isPlatformOperatorEmail(" ", "operator@example.com")).toBe(false);
  });

  it("lets an existing member switch without operator privileges", () => {
    expect(
      decideOrganizationSwitch({
        hasExistingMembership: true,
        actorEmail: "member@example.com",
        configuredOperatorEmail: "operator@example.com",
      }),
    ).toBe("existing_member");
  });

  it("matches the configured operator case- and whitespace-insensitively", () => {
    expect(
      decideOrganizationSwitch({
        hasExistingMembership: false,
        actorEmail: " OPERATOR@EXAMPLE.COM ",
        configuredOperatorEmail: "operator@example.com",
      }),
    ).toBe("platform_operator");
  });
});
