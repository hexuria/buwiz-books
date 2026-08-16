import { test, expect } from "@playwright/test";

test.describe("Departments Search and Filters", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/departments");
    await page.waitForLoadState("networkidle");
  });

  test("should interact with search and filter popover", async ({ page }) => {
    // Locate the search input
    const searchInput = page.getByPlaceholder(/Lookup department/i);
    await expect(searchInput).toBeVisible();

    // Verify search interaction
    await searchInput.fill("test search");
    await expect(searchInput).toHaveValue("test search");

    // Open filter popover
    const filterBtn = page.getByRole("button").filter({ hasText: "Filters" }).first();
    if (await filterBtn.isVisible()) {
      await filterBtn.click();
    } else {
      // sometimes it's just the filter icon
      await page.locator("button:has(svg)").first().click();
    }

    // Check for global Clear button functionality
    const clearBtn = page.getByRole("button", { name: "Clear", exact: true });
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await expect(searchInput).toHaveValue("");
    }
  });

  test("should toggle status filters", async ({ page }) => {
    // Open popover using generic filter button locator
    const filterTrigger = page.locator("button", { has: page.locator("svg") }).first();
    await filterTrigger.click();

    // Status filters might be within a popover
    const _activeFilter = page.getByText("Active", { exact: true }).nth(1);
    const inactiveFilter = page.getByText("Inactive", { exact: true });

    if (await inactiveFilter.isVisible()) {
      await inactiveFilter.click();
    }
  });
});
