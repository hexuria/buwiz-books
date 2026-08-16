import { test, expect } from "@playwright/test";

test.describe("Banks and Cards Account Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/banks");
    await page.waitForLoadState("networkidle");
  });

  test("should show Edit and Delete action buttons after card selection", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/selected=/);

      // Banks uses Edit + Delete (NOT Deactivate like party entities)
      const editBtn = page.getByRole("button", { name: "Edit" }).first();
      await expect(editBtn).toBeVisible();

      const deleteBtn = page.getByRole("button", { name: "Delete" }).first();
      await expect(deleteBtn).toBeVisible();
    }
  });

  test("should show View Insights link on detail panel", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();
      await page.waitForTimeout(500);

      const insightsLink = page.getByRole("link", { name: "View Insights" });
      await expect(insightsLink).toBeVisible();
    }
  });
});
