import { describe, expect, it } from "vitest";
import { InvalidBaseCurrencyError, resolveFunctionalCurrency } from "@/lib/functional-currency";

/**
 * `journal_headers.functional_currency` defaults to 'USD' at the column level
 * and six of the nine posting sites never set it, so a Philippine
 * organization's ledger recorded its own books in dollars unless somebody
 * remembered the field. `organization_accounting_settings.base_currency`
 * defaults to 'USD' too, so there was no layer that would notice.
 *
 * These pin the resolver's three behaviours: use what is configured, fall back
 * only for a genuinely un-onboarded org, and fail loudly on a bad code rather
 * than quietly substituting dollars.
 */
function stubDb(row: { baseCurrency: string } | undefined) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as never;
}

describe("resolveFunctionalCurrency", () => {
  it("returns the organization's configured currency", async () => {
    await expect(resolveFunctionalCurrency(stubDb({ baseCurrency: "PHP" }), "org_1")).resolves.toBe(
      "PHP",
    );
  });

  it("normalizes case and surrounding whitespace", async () => {
    await expect(
      resolveFunctionalCurrency(stubDb({ baseCurrency: " php " }), "org_1"),
    ).resolves.toBe("PHP");
  });

  it("falls back to USD only when the org has no settings row at all", async () => {
    // The pre-onboarding state — the column default applies and there is
    // nothing to validate.
    await expect(resolveFunctionalCurrency(stubDb(undefined), "org_1")).resolves.toBe("USD");
  });

  it("throws rather than defaulting when the configured code is invalid", async () => {
    // Silently substituting a default is exactly how the original defect
    // worked, so an explicitly wrong value must not degrade to dollars.
    await expect(
      resolveFunctionalCurrency(stubDb({ baseCurrency: "PESO" }), "org_1"),
    ).rejects.toThrow(InvalidBaseCurrencyError);
  });

  it("names the organization and the bad value in the error", async () => {
    await expect(
      resolveFunctionalCurrency(stubDb({ baseCurrency: "??" }), "org_bad"),
    ).rejects.toThrow(/org_bad.*"\?\?"/);
  });

  it("does not treat an empty configured currency as valid", async () => {
    // An empty string is falsy, so it takes the un-onboarded path rather than
    // reaching normalizeCurrency — asserted so the branch is deliberate.
    await expect(resolveFunctionalCurrency(stubDb({ baseCurrency: "" }), "org_1")).resolves.toBe(
      "USD",
    );
  });
});
