import { test, expect } from "@playwright/test";

/**
 * This spec previously targeted `page.locator("tbody tr")`. The page has never rendered a table —
 * its rows are divs — so the locator matched nothing, `isVisible()` was always false, and every
 * assertion sat inside that `if`. It passed on every run without checking anything.
 *
 * Two changes fix that class of failure rather than just this instance:
 *   - rows carry `data-testid="dimension-row"`, so the handle cannot silently stop matching
 *   - "no rows" is a `test.skip()`, which reports as skipped. An `if` wrapping the assertions is
 *     indistinguishable from a pass, which is exactly how this went unnoticed.
 *
 * The first test asserts page chrome that does not depend on seeded data, so this spec is never
 * fully vacuous even against an empty database.
 */
test.describe("Departments list and detail view", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/departments");
    await page.waitForLoadState("networkidle");
  });

  test("renders the list shell regardless of data", async ({ page }) => {
    await expect(page.getByRole("button", { name: "New Department" })).toBeVisible();
    await expect(page.getByLabel("Lookup department")).toBeVisible();
  });

  test("opens the detail panel when a row is clicked", async ({ page }) => {
    const rows = page.getByTestId("dimension-row");
    const count = await rows.count();
    test.skip(count === 0, "No departments seeded — cannot exercise the row → detail transition.");

    // The idle panel prompts for a selection; it must be showing before we make one.
    await expect(page.getByText("Select a department")).toBeVisible();

    await rows.first().click();

    // Selection is carried in the URL so the panel survives a reload and can be linked to.
    await expect(page).toHaveURL(/[?&]selected=/);
    // The prompt is replaced by the detail card — an unambiguous signal that the panel swapped,
    // unlike asserting on "Edit", which appears both as a row action and a form heading.
    await expect(page.getByText("Select a department")).toBeHidden();
  });

  test("keeps a way back to the list at 375px, where the panel replaces it", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const rows = page.getByTestId("dimension-row");
    const count = await rows.count();
    test.skip(count === 0, "No departments seeded — cannot exercise the mobile slide-over.");

    await rows.first().click();
    await expect(page).toHaveURL(/[?&]selected=/);

    // Below `lg` the detail is a slide-over covering the list, so dismissal must be reachable.
    await expect(page.getByRole("button", { name: "Close panel" })).toBeVisible();
  });
});
