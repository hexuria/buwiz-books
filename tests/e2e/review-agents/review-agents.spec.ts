import { test, expect } from "@playwright/test";

/**
 * The Review Agents page is retired. Its configuration and the ledger scan live in Settings ->
 * Review Rules (tests/e2e/settings/review-rules.spec.ts); the old address only redirects, so
 * bookmarks and old links never 404. A bare `/review-agents` lands on the Inbox; the old Inbox
 * "Agent settings" links (`?agent=<rule>`) open that rule in the active organization's Settings.
 */
test.describe("Retired Review Agents page", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test("redirects /review-agents to the Inbox", async ({ page }) => {
    await page.goto("/review-agents");
    await expect(page).toHaveURL(/\/inbox(?:\?.*)?$/);
  });

  test("sends an old link to an agent to that rule in Settings", async ({ page }) => {
    await page.goto("/review-agents?agent=unusual_spend&findings=all");
    await expect(page).toHaveURL(
      /\/organization\/[a-zA-Z0-9-]+\/settings\?(?=.*section=review-rules)(?=.*rule=unusual_spend)/,
    );
    await expect(page.getByRole("heading", { name: "Review Rules", level: 2 })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable Unusual Spend" })).toBeVisible();
  });

  test("is gone from the sidebar", async ({ page }) => {
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Inbox" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Review Agents" })).toHaveCount(0);
  });
});
