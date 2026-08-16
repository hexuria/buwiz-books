/**
 * Products Server Functions — List + Create
 */
import { createServerFn } from "@tanstack/react-start";
import { products } from "../../db/schema/products";
import { and, asc, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";

// ============================================================================
// List Products
// ============================================================================

const listProductsSchema = z.object({
  search: z.string().optional(),
  limit: z.number().optional().default(50),
});

export const listProducts = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listProductsSchema>) =>
    listProductsSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { search, limit } = listProductsSchema.parse(rawData ?? {});

      const conditions = [eq(products.isActive, true), eq(products.organizationId, orgId)];

      if (search) {
        conditions.push(ilike(products.name, `%${search}%`));
      }

      let query = db
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(asc(products.name))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      return await query;
    });
  });

// ============================================================================
// Create Product
// ============================================================================

const createProductSchema = z.object({
  name: z.string().min(1),
  defaultPrice: z.string().or(z.number()).optional().default("0"),
  description: z.string().optional(),
});

export const createProduct = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "invoice",
      "create",
      { routeKey: "product:create", limit: 40, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = createProductSchema.parse(rawData);

        const [product] = await db
          .insert(products)
          .values({
            organizationId: orgId,
            name: parsed.name,
            defaultPrice: String(parsed.defaultPrice),
            description: parsed.description,
          })
          .returning();

        return product;
      },
    );
  },
);
