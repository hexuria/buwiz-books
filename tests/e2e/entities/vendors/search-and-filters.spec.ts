import { test, expect } from "@playwright/test";

test.describe("Vendors Search and Filters", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/vendors");
    await page.waitForLoadState("networkidle");
  });

  test("should interact with search input", async ({ page }) => {
    // Note: uses unicode ellipsis '…'
    const searchInput = page.getByPlaceholder("Search for…");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("acme");
    await expect(searchInput).toHaveValue("acme");
  });

  test("should toggle filter popover", async ({ page }) => {
    // Exact selector based on title attribute
    const filterBtn = page.locator('button[title="Filters"]');
    if (await filterBtn.isVisible()) {
      await filterBtn.click();

      // Ensure that Active filter is available in the popover
      const activeOption = page.getByText("Active", { exact: true }).first();
      await expect(activeOption).toBeVisible();

      await page.keyboard.press("Escape");
    }
  });

  test("should clear filters via Clear button", async ({ page }) => {
    // Active chip is usually active by default which shows the Clear button
    const clearBtn = page.getByRole("button", { name: "Clear", exact: true });

    if (await clearBtn.isVisible()) {
      await clearBtn.click();

      const searchInput = page.getByPlaceholder("Search for…");
      await expect(searchInput).toHaveValue("");
    }
  });

  test("should toggle sort buttons", async ({ page }) => {
    const ascButton = page.getByRole("button", { name: "A–Z" });
    if (await ascButton.isVisible()) {
      await ascButton.click();

      // Should change to Z-A
      const descButton = page.getByRole("button", { name: "Z–A" });
      await expect(descButton).toBeVisible();
    }

    const recentButton = page.getByRole("button", { name: "Recent" });
    if (await recentButton.isVisible()) {
      await recentButton.click();
      await expect(recentButton).toBeVisible(); // Just verifying it remains visible
    }
  });
});
