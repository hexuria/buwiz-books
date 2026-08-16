import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { resolve } from "path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env.test") });

const TARGET = "Accrued Revenue";

/**
 * Remove the account this spec creates.
 *
 * Without it the spec is single-use: `filterCategorySuggestions` hides any
 * suggestion whose name already exists, so a second run would never be offered
 * the one it asserts on. Mirrors the direct-postgres approach in
 * tests/e2e/seed-snapshot.ts.
 */
async function deleteTargetAccount() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.includes("buwiz-books-tests")) return;
  const sql = postgres(dbUrl);
  try {
    await sql`DELETE FROM accounts WHERE lower(name) = ${TARGET.toLowerCase()}`;
  } finally {
    await sql.end();
  }
}

/**
 * The "Create New" suggestion path had no coverage at all, which is how it came
 * to fail for roughly 44% of picks without anyone noticing: the suggestion
 * carried a hardcoded `accountNumber` that collided with a different account,
 * `createAccount` hit the unique index, and the catch logged to the console
 * with no toast — leaving the modal open and the button apparently inert.
 *
 * "Accrued Revenue" is chosen deliberately: it is in the catalog, absent from
 * the E2E fixture chart (so it is actually offered), and its parent "Assets"
 * resolves to a real root.
 */
test.describe("Category suggestions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  // Both hooks: `before` clears residue from an interrupted run, `after`
  // leaves the fixture as we found it.
  test.beforeAll(deleteTargetAccount);
  test.afterAll(deleteTargetAccount);

  test.beforeEach(async ({ page }) => {
    await page.goto("/transactions/new?type=pay_out");
    await expect(page.getByText("Select Party", { exact: true })).toBeVisible({ timeout: 15000 });
  });

  async function openCategorySearch(page: import("@playwright/test").Page) {
    await page.getByText("Category", { exact: true }).locator("visible=true").click();
    return page.getByPlaceholder("Select or Create New");
  }

  test("offers a matching suggestion labelled with its parent", async ({ page }) => {
    const search = await openCategorySearch(page);
    await search.fill("accrued");

    await expect(page.getByText("Create New", { exact: true })).toBeVisible({ timeout: 10000 });

    const suggestion = page.getByRole("button", { name: /Accrued Revenue/ });
    await expect(suggestion.first()).toBeVisible();
    // The sublabel is the parent, not a number: numbering is now server-side,
    // derived from that parent, so a catalog number would only ever go stale.
    await expect(suggestion.first()).toContainText("Assets");
    await expect(suggestion.first()).not.toContainText("undefined");
  });

  test("matches on keywords, not just the name", async ({ page }) => {
    // "earned revenue" is a keyword on Accrued Revenue and appears in no
    // account name — so a hit proves the keywords array is still doing work.
    const search = await openCategorySearch(page);
    await search.fill("earned revenue");
    await expect(page.getByRole("button", { name: /Accrued Revenue/ }).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("creating from a suggestion succeeds and closes the modal", async ({ page }) => {
    const search = await openCategorySearch(page);
    await search.fill("accrued");
    await page
      .getByRole("button", { name: /Accrued Revenue/ })
      .first()
      .click();

    // The modal opens prefilled from the suggestion.
    const nameField = page.getByPlaceholder("Activate or create new...");
    await expect(nameField).toBeVisible({ timeout: 10000 });
    await expect(nameField).toHaveValue(/Accrued Revenue/);

    await page.getByRole("button", { name: /^Create$/ }).click();

    // THE regression: before the fix the insert failed on a duplicate account
    // number and the modal simply stayed open with no feedback. A closed modal
    // is proof the account was actually created.
    await expect(nameField).toBeHidden({ timeout: 15000 });
  });
});
