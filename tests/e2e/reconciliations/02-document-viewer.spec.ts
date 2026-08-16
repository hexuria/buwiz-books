import { test, expect } from "@playwright/test";

const RECON_ID_WITH_DOC = "5b6077b6-3ae3-437d-95ab-7281455d8494";

test.describe("Reconciliation Document Viewer", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.describe("With attached document", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/reconciliations/${RECON_ID_WITH_DOC}`);
      await expect(page.getByRole("heading", { name: /Mercury Checking 1231/i })).toBeVisible({
        timeout: 15_000,
      });
    });

    test("renders generating state or viewer without crashing", async ({ page }) => {
      // Use locator.or() with toBeVisible() to rely on Playwright's auto-waiting.
      // This ensures we wait for either the Suspense fallback, the preview text,
      // the document actions, or the actual viewer to appear instead of failing instantly.
      await expect(
        page
          .getByText(/Loading statement viewer|Generating preview/i)
          .or(page.getByRole("button", { name: "Remove Statement" }))
          .or(page.getByTitle("Zoom In")),
      ).toBeVisible();
    });
  });
});
