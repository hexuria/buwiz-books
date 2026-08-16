/**
 * User Preferences Schema
 * Stores per-user settings like timezone.
 * Separate from auth_users (managed by better-auth) to avoid adapter conflicts.
 */
import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { user } from "./auth";

export const userPreferences = pgTable("user_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Link to auth user (1:1)
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),

  // IANA timezone identifier (e.g. "America/New_York", "Asia/Manila")
  timezone: varchar("timezone", { length: 100 }).notNull().default("UTC"),

  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(user, {
    fields: [userPreferences.userId],
    references: [user.id],
  }),
}));
