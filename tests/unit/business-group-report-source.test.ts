import { describe, expect, it } from "vitest";
import {
  invalidProjectionAllowlistWarning,
  normalizeBusinessGroupReportSource,
  parseProjectionAccountAllowlist,
  resolveBusinessGroupReportSource,
} from "../../src/lib/business-groups/report-source";

const CANARY_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";

describe("Business Group report source", () => {
  it("fails unknown and unset global values back to live", () => {
    expect(normalizeBusinessGroupReportSource(undefined)).toBe("live");
    expect(normalizeBusinessGroupReportSource("anything-else")).toBe("live");
    expect(normalizeBusinessGroupReportSource(" SHADOW ")).toBe("shadow");
  });

  it("uses projection only for allowlisted accounts while the global source is shadow", () => {
    expect(
      resolveBusinessGroupReportSource({
        configuredSource: "shadow",
        configuredAccountAllowlist: CANARY_ACCOUNT,
        enterpriseAccountId: CANARY_ACCOUNT,
      }).source,
    ).toBe("projection");
    expect(
      resolveBusinessGroupReportSource({
        configuredSource: "shadow",
        configuredAccountAllowlist: CANARY_ACCOUNT,
        enterpriseAccountId: OTHER_ACCOUNT,
      }).source,
    ).toBe("shadow");
  });

  it("keeps global live and projection modes independent from the allowlist", () => {
    expect(
      resolveBusinessGroupReportSource({
        configuredSource: "live",
        configuredAccountAllowlist: CANARY_ACCOUNT,
        enterpriseAccountId: CANARY_ACCOUNT,
      }).source,
    ).toBe("live");
    expect(
      resolveBusinessGroupReportSource({
        configuredSource: "projection",
        configuredAccountAllowlist: "none",
        enterpriseAccountId: OTHER_ACCOUNT,
      }).source,
    ).toBe("projection");
  });

  it("treats an empty allowlist as all-shadow", () => {
    for (const configuredAccountAllowlist of [undefined, "", "none"]) {
      expect(
        resolveBusinessGroupReportSource({
          configuredSource: "shadow",
          configuredAccountAllowlist,
          enterpriseAccountId: CANARY_ACCOUNT,
        }).source,
      ).toBe("shadow");
    }
  });

  it("deduplicates valid UUIDs and ignores malformed tokens without broadening the canary", () => {
    const parsed = parseProjectionAccountAllowlist(
      `${CANARY_ACCOUNT}, INVALID,${CANARY_ACCOUNT.toUpperCase()},almost-a-uuid`,
    );

    expect([...parsed.accountIds]).toEqual([CANARY_ACCOUNT]);
    expect(parsed.invalidTokenCount).toBe(2);
    expect(
      resolveBusinessGroupReportSource({
        configuredSource: "shadow",
        configuredAccountAllowlist: "*",
        enterpriseAccountId: OTHER_ACCOUNT,
      }),
    ).toEqual({ source: "shadow", invalidAllowlistTokenCount: 1 });
  });

  it("builds a value-free structured warning for malformed configuration", () => {
    expect(invalidProjectionAllowlistWarning(0)).toBeNull();
    const warning = invalidProjectionAllowlistWarning(2);
    expect(warning).toEqual({
      severity: "WARNING",
      event: "business_group_projection_allowlist_invalid",
      invalidTokenCount: 2,
    });
    expect(JSON.stringify(warning)).not.toContain(CANARY_ACCOUNT);
  });
});
