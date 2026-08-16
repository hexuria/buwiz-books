import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { accounts } from "../schema/accounts";

/**
 * Zod schemas for Account model
 */
export const insertAccountSchema = createInsertSchema(accounts);
export const selectAccountSchema = createSelectSchema(accounts);

export type InsertAccount = typeof accounts.$inferInsert;
export type Account = typeof accounts.$inferSelect;
