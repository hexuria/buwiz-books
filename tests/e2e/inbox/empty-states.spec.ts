import { test, expect } from "@playwright/test";

/**
 * The user's original report was "icons aren't showing" on the Inbox. Nothing was broken — the
 * page simply had none, and used CSS shapes in their place: a bare circle in the search gutter
 * and one grey square standing in for four different empty states.
 *
 * These assert real `<svg>` glyphs, because a passing "the page rendered" test would not have
 * caught the original problem.
 */
test.describe("Inbox icons and empty states", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/inbox");
    await page.waitForLoadState("networkidle");
  });

  test("renders a real magnifier in the search field, not a bare circle", async ({ page }) => {
    const search = page.getByLabel("Search Inbox");
    await expect(search).toBeVisible();

    // The icon sits in the input's pl-9 gutter, inside the same relative wrapper.
    const icon = search.locator("xpath=..").locator("svg");
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
  });

  test("gives the detail pane's empty state its own glyph", async ({ page }) => {
    const detail = page.getByText("Select a transaction");
    await expect(detail).toBeVisible();
    // Ascend to the EmptyState wrapper and confirm a glyph rendered alongside the copy.
    await expect(detail.locator("xpath=../..").locator("svg")).toHaveCount(1);
  });

  test("distinguishes a fruitless search from a genuinely clear queue", async ({ page }) => {
    await page.getByLabel("Search Inbox").fill("zzz-no-such-transaction-zzz");
    await expect(page.getByText("No matching transactions")).toBeVisible();
    await expect(
      page.getByText("Try a different transaction, vendor, or source name."),
    ).toBeVisible();
    const emptyIcon = page
      .getByText("No matching transactions")
      .locator("xpath=../..")
      .locator("svg");
    await expect(emptyIcon).toHaveCount(1);
  });
});
