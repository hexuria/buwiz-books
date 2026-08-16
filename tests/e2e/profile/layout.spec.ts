import { test, expect } from "@playwright/test";

test.describe("Profile Page Layout", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
  });

  test("renders all profile sections", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Personal Information" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Linked Accounts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organization" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  });

  test("displays read-only fields correctly", async ({ page }) => {
    await expect(page.getByText("Email", { exact: true })).toBeVisible();
    await expect(page.locator(".profile-value-readonly")).toContainText("hugoforbes88@gmail.com");
    await expect(page.getByText("Verified")).toBeVisible();

    // The avatar element (expecting no file upload right now)
    const avatar = page
      .locator('div[class*="rounded-full"]')
      .filter({ hasText: /^[A-Z]$/ })
      .first();
    await expect(avatar).toBeVisible();

    // Verification of standard attributes existing on the page
    await expect(page.getByText("User ID")).toBeVisible();
    await expect(page.getByText("Member Since")).toBeVisible();
  });
});
