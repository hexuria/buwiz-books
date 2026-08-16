import { test, expect } from "@playwright/test";

test.describe("Locations Layout and Responsive", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/locations");
    await page.waitForLoadState("networkidle");
  });

  test("should display main headers and default structure", async ({ page }) => {
    // Check main title (it's a span, not an h1)
    await expect(page.getByText("Locations", { exact: true }).first()).toBeVisible();

    // Check Back to Dashboard link
    const backBtn = page.getByRole("link", { name: /Back to Dashboard/i });
    await expect(backBtn).toBeVisible();
    await expect(backBtn).toHaveAttribute("href", "/");

    // Check the primary button
    const newBtn = page.getByRole("button", { name: "New Location" }).first();
    await expect(newBtn).toBeVisible();
  });
});
