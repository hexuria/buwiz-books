/**
 * User Preferences API Server Functions
 * Get and update per-user settings (timezone, etc.)
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { withUserContext } from "../../db";
import { userPreferences } from "../../db/schema/user-preferences";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "../../lib/auth-middleware";

// ============================================================================
// Schemas
// ============================================================================

const updatePreferencesSchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
});

// ============================================================================
// Server Functions
// ============================================================================

/**
 * Get the current user's preferences.
 * Returns defaults if no preferences row exists yet.
 */
export const getUserPreferences = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession(getRequest()!.headers);
  const userId = session.user.id;

  // Runs in user RLS context (sets app.current_user_id) so the user_preferences
  // policy (user_id = current_user_id()) passes once FORCE RLS is enabled.
  const [prefs] = await withUserContext(userId, (tx) =>
    tx.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
  );

  return {
    timezone: prefs?.timezone ?? "UTC",
  };
});

/**
 * Update the current user's preferences.
 * Creates the row if it doesn't exist (upsert).
 */
export const updateUserPreferences = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    const session = await requireSession(getRequest()!.headers);
    const userId = session.user.id;
    const parsed = updatePreferencesSchema.parse(rawData);

    // Upsert: try insert, fall back to update on conflict.
    // Whole upsert runs in one user RLS context (sets app.current_user_id) so the
    // user_preferences policy passes once FORCE RLS is enabled.
    const now = new Date();

    await withUserContext(userId, async (tx) => {
      // Check if row exists first
      const [existing] = await tx
        .select({ id: userPreferences.id })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);

      if (existing) {
        // Update existing preferences
        const updateFields: Record<string, any> = { updatedAt: now };
        if (parsed.timezone !== undefined) {
          updateFields.timezone = parsed.timezone;
        }
        await tx
          .update(userPreferences)
          .set(updateFields)
          .where(eq(userPreferences.userId, userId));
      } else {
        // Insert new preferences
        await tx.insert(userPreferences).values({
          userId,
          timezone: parsed.timezone ?? "UTC",
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    return { success: true };
  },
);
