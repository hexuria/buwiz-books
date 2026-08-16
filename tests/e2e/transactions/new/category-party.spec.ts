import { test, expect } from "@playwright/test";

test.describe("New Transaction Category & Party Comboboxes", () => {
  // Rely on setup auth
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/transactions/new?type=pay_out");
    await expect(page.getByText("Select Party", { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test("party combobox is visible and allows searching vendors", async ({ page }) => {
    // Check if the vendor (party) combobox is present
    const vendorInput = page.getByText("Select Party", { exact: true });
    await expect(vendorInput).toBeVisible();

    // Click to open the combobox
    await vendorInput.click();

    // The search input appears when the combobox is open
    const searchInput = page.getByPlaceholder("Find party...");
    await searchInput.fill("Google");

    // We expect the dropdown combobox logic to show results or "Create Party"
    // Just verify the listbox appears indicating the UI is interactive
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
  });

  test("category combobox expands on interaction", async ({ page }) => {
    // The Category placeholder is visible as text inside the generic pay lines component
    // Filter strictly by visibility to target whichever layout viewport is currently active
    const categoryInput = page.getByText("Category", { exact: true }).locator("visible=true");

    await categoryInput.click();

    // The search input appears when the combobox is open
    const searchInput = page.getByPlaceholder("Select or Create New");
    await searchInput.fill("Software");

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
  });
});
