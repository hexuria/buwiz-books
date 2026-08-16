import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
});

test.describe("Ledger Search Functionality", () => {
  test("renders the search input within the ledger header", async ({ page }) => {
    const searchInput = page.getByTestId("search-input").first();
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute("placeholder", /Filter.*transactions/i);
  });

  test("typing in search input updates local state without pushing search context to URL", async ({
    page,
  }) => {
    const searchInput = page.getByTestId("search-input").first();
    await searchInput.fill("stripe");

    // Verify it retains the text (debounced fetching happens internally)
    await expect(searchInput).toHaveValue("stripe");

    // The search term is deliberately local, it shouldn't inject `query=stripe` into the URL
    await expect(page.url()).not.toContain("query=stripe");
    await expect(page.url()).not.toContain("search=stripe");
  });

  test("clearing the search input removes the text", async ({ page }) => {
    const searchInput = page.getByTestId("search-input").first();
    await searchInput.fill("mercury");
    await expect(searchInput).toHaveValue("mercury");

    // Clear the input
    await searchInput.fill("");
    await expect(searchInput).toHaveValue("");
  });
});
