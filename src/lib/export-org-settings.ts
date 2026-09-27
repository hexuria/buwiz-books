/**
 * The `orgSettings` export row (Settings → Export / Import).
 *
 * `auth_organizations.metadata` is a JSON *string*. The export used to cast that string to an
 * object, so every field read `undefined` and every file carried the defaults — USD and nulls —
 * whatever the organization had actually set. It is parsed here with the parser every other
 * metadata reader uses, so the file says what Settings shows.
 */
import { parseOrgMetadata } from "./org-metadata";

export interface OrgSettingsExportRow {
  name: string;
  slug: string;
  currency: string;
  phone: string | null;
  website: string | null;
  taxId: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
  logoUrl: string | null;
}

export function orgSettingsExportRow(org: {
  name: string;
  slug: string;
  metadata: string | null;
}): OrgSettingsExportRow {
  const meta = parseOrgMetadata(org.metadata);
  return {
    name: org.name,
    slug: org.slug,
    currency: meta.currency ?? "USD",
    phone: meta.phone ?? null,
    website: meta.website ?? null,
    taxId: meta.taxId ?? null,
    addressStreet: meta.addressStreet ?? null,
    addressCity: meta.addressCity ?? null,
    addressState: meta.addressState ?? null,
    addressPostalCode: meta.addressPostalCode ?? null,
    addressCountry: meta.addressCountry ?? null,
    logoUrl: meta.logoUrl ?? null,
  };
}
