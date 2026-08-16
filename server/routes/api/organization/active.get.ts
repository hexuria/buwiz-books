import { createError, defineEventHandler, getRequestHeaders } from "h3";
import { eq } from "drizzle-orm";
import { getSessionContext } from "../../../../src/lib/auth-middleware";
import { withOrgContext } from "../../../../src/db";
import { organization } from "../../../../src/db/schema/auth";
import { parseOrgMetadata } from "../../../../src/lib/org-metadata";

export default defineEventHandler(async (event) => {
  try {
    const session = await getSessionContext(new Headers(getRequestHeaders(event)));
    return await withOrgContext(session.orgId, session.userId, session.role, async (db) => {
      const [org] = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          logo: organization.logo,
          metadata: organization.metadata,
        })
        .from(organization)
        .where(eq(organization.id, session.orgId))
        .limit(1);
      if (!org) throw createError({ statusCode: 404, message: "Organization not found" });

      const metadata = parseOrgMetadata(org.metadata);
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        logoUrl: org.logo ?? undefined,
        currency: metadata.currency ?? "USD",
      };
    });
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({ statusCode: 401, message: "Authentication required" });
  }
});
