import { describe, expect, it } from "vitest";
import { orgSettingsExportRow } from "@/lib/export-org-settings";

/**
 * `auth_organizations.metadata` is a JSON string. The orgSettings export used to cast it to an
 * object, so every file carried USD and nulls whatever the organization had set. The row is now
 * built from the parsed metadata.
 */
describe("orgSettingsExportRow", () => {
  const org = { name: "Acme Books", slug: "acme-books" };

  it("exports what the organization set, read out of the metadata JSON string", () => {
    const metadata = JSON.stringify({
      currency: "PHP",
      phone: "+63 2 8123 4567",
      website: "https://acme.example",
      taxId: "123-456-789-000",
      addressStreet: "1 Ayala Ave",
      addressCity: "Makati",
      addressState: "NCR",
      addressPostalCode: "1226",
      addressCountry: "PH",
      logoUrl: "https://cdn.example/acme.png",
    });
    expect(orgSettingsExportRow({ ...org, metadata })).toEqual({
      name: "Acme Books",
      slug: "acme-books",
      currency: "PHP",
      phone: "+63 2 8123 4567",
      website: "https://acme.example",
      taxId: "123-456-789-000",
      addressStreet: "1 Ayala Ave",
      addressCity: "Makati",
      addressState: "NCR",
      addressPostalCode: "1226",
      addressCountry: "PH",
      logoUrl: "https://cdn.example/acme.png",
    });
  });

  it("falls back to defaults only for what is really missing", () => {
    const row = orgSettingsExportRow({ ...org, metadata: JSON.stringify({ taxId: "99-1" }) });
    expect(row.taxId).toBe("99-1");
    expect(row.currency).toBe("USD");
    expect(row.phone).toBeNull();
  });

  it("exports defaults for missing or unreadable metadata instead of failing", () => {
    for (const metadata of [null, "", "{not json", "[]"]) {
      const row = orgSettingsExportRow({ ...org, metadata });
      expect(row).toMatchObject({
        name: "Acme Books",
        currency: "USD",
        taxId: null,
        logoUrl: null,
      });
    }
  });

  it("carries only the settings fields — never credentials or unrelated metadata", () => {
    const row = orgSettingsExportRow({
      ...org,
      metadata: JSON.stringify({
        currency: "EUR",
        geminiApiKeys: ["AIza-secret"],
        stripeSecretKey: "sk_live_secret",
        inboxV2: true,
      }),
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        "addressCity",
        "addressCountry",
        "addressPostalCode",
        "addressState",
        "addressStreet",
        "currency",
        "logoUrl",
        "name",
        "phone",
        "slug",
        "taxId",
        "website",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(row.currency).toBe("EUR");
  });
});
