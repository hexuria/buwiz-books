import { test, expect } from "@playwright/test";

test.describe("Settings Layout and Navigation", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test("should navigate to settings and display the correct layout", async ({ page }) => {
    // Navigate from the home page
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click on the Settings link in the sidebar
    await page.getByRole("link", { name: "Settings" }).click();

    // Verify URL
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);

    // Verify Header
    await expect(page.getByRole("heading", { name: "Organization Settings" })).toBeVisible();

    // Verify Sidebar Navigation elements
    const tabs = [
      "General",
      "Business Profile",
      "Email",
      "AI Credentials",
      "Members",
      "Export / Import",
    ];

    for (const tab of tabs) {
      await expect(page.getByRole("button", { name: tab })).toBeVisible();
    }
  });

  test("should toggle between different settings sections", async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);

    // Default should be General
    await expect(page.getByRole("heading", { name: "General" }).first()).toBeVisible();

    // Click Business Profile
    await page.getByRole("button", { name: "Business Profile" }).click();
    await expect(page.getByRole("heading", { name: "Business Profile" }).first()).toBeVisible();

    // Click Email
    await page.getByRole("button", { name: "Email" }).click();
    await expect(page.getByRole("heading", { name: "Email" }).first()).toBeVisible();

    // Click Members
    await page.getByRole("button", { name: "Members" }).click();
    await expect(page.getByRole("heading", { name: "Members" }).first()).toBeVisible();
  });
});
