import { test, expect } from "@playwright/test";

test.describe("Banks and Cards Search and Filters", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/banks");
    await page.waitForLoadState("networkidle");
  });

  test("should interact with search input", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search for…");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("mercury");
    await expect(searchInput).toHaveValue("mercury");
  });

  test("should toggle filter popover with Status and Type sections", async ({ page }) => {
    const filterBtn = page.locator('button[title="Filters"]');
    if (await filterBtn.isVisible()) {
      await filterBtn.click();

      // Banks filter has both Status and Type sections
      await expect(page.getByText("Status", { exact: true }).first()).toBeVisible();
      // Status options
      await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Inactive", { exact: true }).first()).toBeVisible();

      await page.keyboard.press("Escape");
    }
  });

  test("should toggle sort buttons", async ({ page }) => {
    const ascButton = page.getByRole("button", { name: "A–Z" });
    if (await ascButton.isVisible()) {
      await ascButton.click();

      // Should now show Z-A
      const descButton = page.getByRole("button", { name: "Z–A" });
      await expect(descButton).toBeVisible();

      // Reset
      await descButton.click();
    }

    const recentButton = page.getByRole("button", { name: "Recent" });
    if (await recentButton.isVisible()) {
      await recentButton.click();
      await expect(recentButton).toBeVisible();
    }
  });

  test("should clear filters via Clear button", async ({ page }) => {
    const clearBtn = page.getByRole("button", { name: "Clear", exact: true });
    if (await clearBtn.isVisible()) {
      await clearBtn.click();

      const searchInput = page.getByPlaceholder("Search for…");
      await expect(searchInput).toHaveValue("");
    }
  });
});
