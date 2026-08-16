import { test, expect } from "@playwright/test";

test.describe("Banks and Cards Detail View", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/banks");
    await page.waitForLoadState("networkidle");
  });

  test("should select an account card and show detail panel", async ({ page }) => {
    // Cards are rendered as <button class="... rounded-xl ..."> inside .overflow-y-auto
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();
      await page.waitForTimeout(500);

      // URL updates with ?selected=<uuid>
      await expect(page).toHaveURL(/selected=/);

      // Edit button confirms detail panel loaded
      const editBtn = page.getByRole("button", { name: "Edit" }).first();
      await expect(editBtn).toBeVisible();
    }
  });

  test("should display expected financial detail sections", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();
      await page.waitForTimeout(500);

      // View Insights link is always present
      const insightsLink = page.getByRole("link", { name: "View Insights" });
      await expect(insightsLink).toBeVisible();

      // Financial-specific info fields (rendered as uppercase labels in HTML)
      await expect(page.getByText("Account Type", { exact: false })).toBeVisible();
      await expect(page.getByText("Status", { exact: false }).first()).toBeVisible();
      await expect(page.getByText("Last Four", { exact: false })).toBeVisible();
      await expect(page.getByText("Source", { exact: false })).toBeVisible();
      await expect(page.getByText("Linked Ledger Category", { exact: false })).toBeVisible();
    }
  });
});
