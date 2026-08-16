import { test, expect } from "@playwright/test";

test.describe("Chart of Accounts - Hierarchy Loop Prevention", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Go to accounts with tree view visible
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("should prevent setting an account's parent to itself (infinite loop) via UI filtering", async ({
    page,
  }) => {
    const desktopPanel = page.locator("div.hidden.lg\\:block");

    // 1. Expand the "Assets" root category
    const assetsRow = page.locator(".group.grid").filter({ hasText: "Assets" }).first();
    await expect(assetsRow).toBeVisible();

    // The toggle button is the first button in the row
    const expandBtn = assetsRow.locator('button[aria-label="Expand"]');
    // We only click if it says Expand. If it says Collapse, it's already open.
    // We can just click the expand button directly, but we need to wait for it.
    await expandBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    // 2. Click on "Bank Accounts", which is a direct child of Assets
    const bankAccountsRow = page
      .locator(".group.grid")
      .filter({ hasText: "Bank Accounts" })
      .first();
    await expect(bankAccountsRow).toBeVisible();
    await bankAccountsRow.click();

    // 3. Open edit mode
    await desktopPanel.locator('button[title="Edit"]').click();
    await expect(page).toHaveURL(/.*mode=edit.*/);

    // 4. Open parent combobox
    // It should say "Assets" or "Select parent..."
    const parentCombobox = desktopPanel
      .getByRole("button")
      .filter({ hasText: /Assets|Select parent/i })
      .first();
    await parentCombobox.click();

    // 5. Type its own name in the search
    await desktopPanel.getByPlaceholder("Type to filter...").fill("Bank Accounts");

    // 6. Verify the UI filters it out to prevent self-loop
    // The list will always have "No parent (root level)", but "Bank Accounts" should be missing
    const selfOption = desktopPanel
      .locator(".parent-combo-list")
      .getByText("Bank Accounts", { exact: false });
    await expect(selfOption).not.toBeVisible();

    const rootOption = desktopPanel
      .locator(".parent-combo-list")
      .getByText("No matching categories", { exact: false });
    await expect(rootOption).toBeVisible();
  });
});
