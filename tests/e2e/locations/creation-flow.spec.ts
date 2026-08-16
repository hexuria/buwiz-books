import { test, expect } from "@playwright/test";

test.describe("Locations Creation Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/locations");
    await page.waitForLoadState("networkidle");
  });

  test("should open the creation form and cancel", async ({ page }) => {
    // Click New Location
    const newLocationBtn = page.getByRole("button", { name: "New Location" }).first();
    await newLocationBtn.click();

    // Check if the panel opens
    const panelHeader = page.getByText("New Location", { exact: true }).first();
    await expect(panelHeader).toBeVisible();

    // Locate form fields in desktop panel to avoid strict mode violations
    const desktopPanel = page.locator(".hidden.lg\\:block");
    const nameInput = desktopPanel.getByPlaceholder("Enter location name");
    await expect(nameInput).toBeVisible();

    const descInput = desktopPanel.getByPlaceholder(/Enter a description/i);
    await expect(descInput).toBeVisible();

    // Try Cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    // Panel might close or revert to default header
    await expect(nameInput).not.toBeVisible();
  });

  test("should interact with creation fields without saving", async ({ page }) => {
    const newLocationBtn = page.getByRole("button", { name: "New Location" }).first();
    await newLocationBtn.click();

    // Scoped locators for right-hand panel
    const desktopPanel = page.locator(".hidden.lg\\:block");
    const nameInput = desktopPanel.getByPlaceholder("Enter location name");
    await nameInput.fill("E2E Test Location");

    const descInput = desktopPanel.getByPlaceholder(/Enter a description/i);
    await descInput.fill("E2E description");

    // Verify parent location dropdown exists
    const dropdown = page.getByText("None (root)").first();
    if (await dropdown.isVisible()) {
      await dropdown.click();
      await page.keyboard.press("Escape");
    }

    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });
});
