import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const numberSequences = pgTable("number_sequences", {
  scope: text("scope").primaryKey(),
  currentValue: integer("current_value").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
