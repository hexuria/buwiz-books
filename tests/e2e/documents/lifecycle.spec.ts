import { test, expect } from "@playwright/test";
import path from "path";

test.describe("Documents Lifecycle", () => {
  test("should upload, view, and delete a document", async ({ page }) => {
    test.setTimeout(60000);
    await page.goto("/documents");
    await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();

    // 2. Open Upload Modal
    await page.getByRole("button", { name: "Upload Document" }).first().click();
    await expect(page.getByRole("heading", { name: "Upload Document" })).toBeVisible();

    // 3. Select file to upload
    const testFilePath = path.join(process.cwd(), "test-statement-2026-01.pdf");

    // We use setInputFiles on the hidden file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);

    // Provide a unique display title so we can easily find and delete it
    const uniqueTitle = `E2E Doc ${Date.now()}`;
    await page.getByPlaceholder("Document title...").fill(uniqueTitle);

    // 4. Click Upload inside the modal.
    // Scoped by role, not by `.fixed.inset-0.z-50`: that selector was the old hand-rolled
    // overlay's own class list, so it broke the moment this modal moved onto the shared Modal
    // primitive — a passing test coupled to a stacking-context utility class. `role="dialog"`
    // is what the modal actually promises.
    await page
      .getByRole("dialog")
      .getByRole("button")
      .filter({ hasText: /^Upload\s*$/ })
      .click();

    // Wait for modal to disappear
    await expect(page.getByRole("heading", { name: "Upload Document" })).not.toBeVisible({
      timeout: 15000,
    });

    // 5. Verify document appears in the list/grid
    // Use the search filter to find it quickly
    await page.getByPlaceholder(/Filter/).fill(uniqueTitle);

    // Wait for the document card/row to be visible
    const docLocator = page.getByText(uniqueTitle);
    await expect(docLocator).toBeVisible({ timeout: 10000 });

    // 6. Navigate to detail view
    await docLocator.click();
    await expect(page.getByText(uniqueTitle).first()).toBeVisible();

    // Verify it is recognized as a PDF
    await expect(page.getByText("Type", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("PDF", { exact: true }).first()).toBeVisible();

    // 7. Delete the document
    await page.getByRole("button", { name: "Delete", exact: true }).first().click();

    // Confirm deletion in the popover
    const confirmDeleteBtn = page.getByRole("button", { name: "Delete", exact: true }).last();
    await confirmDeleteBtn.waitFor({ state: "visible" });
    await confirmDeleteBtn.click();

    // 8. Verify redirected back to list and document is gone
    await expect(page).toHaveURL(/.*\/documents$/);
    await page.getByPlaceholder(/Filter/).fill(uniqueTitle);
    await expect(page.getByText("No documents yet")).toBeVisible();
  });
});
