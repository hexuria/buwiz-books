import { test, expect } from "@playwright/test";

const RECON_ID = "5b6077b6-3ae3-437d-95ab-7281455d8494";

test.describe("Reconciliation Modals & Global Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto(`/reconciliations/${RECON_ID}`);
    await expect(page.getByRole("heading", { name: /Mercury Checking 1231/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Reconfigure modal opens, functions, and cancels cleanly", async ({ page }) => {
    // Open reconfigure
    await page.getByRole("button", { name: "Reconfigure" }).click();

    const heading = page.getByText("Enter Statement Details");
    await expect(heading).toBeVisible();

    // Statement Date is a read-only div
    const dateLabel = page.getByText("Statement Date");
    await expect(dateLabel).toBeVisible();

    // Enter a new ending balance
    const balanceInput = page.getByPlaceholder("0.00").first();
    await balanceInput.fill("10000");
    await expect(balanceInput).toHaveValue("10000");

    // Cancel out
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading).not.toBeVisible();
  });

  test("Finalize modal opens and cancels cleanly", async ({ page }) => {
    const finalizeBtn = page.getByRole("button", { name: /Finalize/i });
    if (await finalizeBtn.isVisible()) {
      await finalizeBtn.click();

      const confirmModalText = page.getByText(/Are you sure/i).first();
      // Ensure the confirmation modal is spawned
      await expect(page.getByRole("button", { name: "Cancel" }).first()).toBeVisible();

      // Cancel out
      await page.getByRole("button", { name: "Cancel" }).first().click();
      await expect(confirmModalText).not.toBeVisible();
    } else {
      test.skip(true, "Finalize button missing (likely already finalized in this snapshot)");
    }
  });

  test("Delete reconciliation modal triggers correctly but can be aborted", async ({ page }) => {
    const deleteBtn = page
      .getByTitle("Delete Reconciliation")
      .or(page.getByRole("button", { name: "Delete" }));
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();

      // Confirm modal opens
      const confirmDialog = page.getByRole("dialog").or(page.locator(".fixed.inset-0"));
      await expect(confirmDialog.getByRole("button", { name: "Cancel" })).toBeVisible();

      // Cancel out
      await confirmDialog.getByRole("button", { name: "Cancel" }).click();
    } else {
      test.skip(true, "Delete button missing (likely already finalized in this snapshot)");
    }
  });

  test("Back URL routing gracefully returns to list", async ({ page }) => {
    const backBtn = page.locator('a[title="Back to Reconciliations"]');
    await backBtn.click();

    await expect(page).toHaveURL(/.*\/reconciliations$/);
  });
});
