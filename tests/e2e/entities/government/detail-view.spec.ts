import { test, expect } from "@playwright/test";

test.describe("Government Detail View", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/government");
    await page.waitForLoadState("networkidle");
  });

  test("should select a card and show detail panel", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();

      // URL should update with selected param
      await expect(page).toHaveURL(/selected=/);

      // Detail panel should load, verified by Edit button presence in the details toolbar
      const editBtn = page.getByRole("button", { name: "Edit" }).first();
      await expect(editBtn).toBeVisible();
    }
  });

  test("should display expected detail sections", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();

      // Ensure that View Insights link is rendered
      const insightsLink = page.getByRole("link", { name: "View Insights" });
      await expect(insightsLink).toBeVisible();

      // Headings might visually render as uppercase but match their literal HTML text
      await expect(page.getByText("Contact", { exact: false })).toBeVisible();
    }
  });
});
