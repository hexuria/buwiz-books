import { test, expect } from "@playwright/test";

test.describe("Departments Layout and Responsive", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/departments");
    await page.waitForLoadState("networkidle");
  });

  test("should display main headers and default structure", async ({ page }) => {
    // Check main title
    await expect(page.getByText("Departments", { exact: true }).first()).toBeVisible();

    // Check Back to Dashboard link
    const backBtn = page.getByRole("link", { name: /Back to Dashboard/i });
    await expect(backBtn).toBeVisible();
    await expect(backBtn).toHaveAttribute("href", "/");

    // Check the primary button (top right usually outside panel, or in header)
    const newBtn = page.getByRole("button", { name: "New Department" }).first();
    await expect(newBtn).toBeVisible();
  });
});
