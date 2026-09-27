import { test, expect } from "@playwright/test";

/**
 * The Review Agents page is retired. Its configuration and the ledger scan live in Settings ->
 * Review Rules (tests/e2e/settings/review-rules.spec.ts); the old address only redirects, so
 * bookmarks and old links land in the Inbox instead of a 404.
 */
test.describe("Retired Review Agents page", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test("redirects /review-agents to the Inbox", async ({ page }) => {
    await page.goto("/review-agents");
    await expect(page).toHaveURL(/\/inbox(?:\?.*)?$/);
  });

  test("redirects an old deep link to an agent, dropping its parameters", async ({ page }) => {
    await page.goto("/review-agents?agent=unusual_spend&findings=all");
    await expect(page).toHaveURL(/\/inbox(?:\?.*)?$/);
    await expect(page).not.toHaveURL(/agent=/);
  });

  test("is gone from the sidebar", async ({ page }) => {
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Inbox" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Review Agents" })).toHaveCount(0);
  });
});
