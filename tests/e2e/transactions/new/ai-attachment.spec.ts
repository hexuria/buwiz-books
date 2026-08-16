import { test, expect } from "@playwright/test";

test.describe("New Transaction AI Attachments", () => {
  // Rely on setup auth
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Navigate to Journal tab as it supports attachments broadly
    await page.goto("/transactions/new?type=journal");
    await expect(page.getByRole("heading", { name: "Journal" })).toBeVisible({ timeout: 15000 });
  });

  test("document attachment drops zone is present", async ({ page }) => {
    // The transaction page should have a dropzone area for receipts/invoices
    // UI strings use the exact wording "or Drag & Drop"
    const dropzone = page.getByText("Drag & Drop", { exact: false }).first();
    await expect(dropzone).toBeVisible();

    // There should also be an explicit file input, which might be hidden visually
    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toBeAttached();
  });

  test("the 'Parse with AI' action only appears once a document is attached", async ({ page }) => {
    // The AI parse action ("✨ Parse with AI") is rendered per attachment, so
    // with no file attached it must not be present at all. (The old assertion
    // looked for a /scan|auto-fill/ label that does not exist, so it silently
    // matched nothing and passed regardless.)
    const aiParseButton = page.getByRole("button", { name: /parse with ai/i });
    await expect(aiParseButton).toHaveCount(0);
  });

  test("attaching a file surfaces the 'Parse with AI' action", async ({ page }) => {
    // Positive-path guard: this assertion is UNCONDITIONAL so a renamed or
    // removed button fails the test instead of silently skipping (the failure
    // mode of the old spec). Attaching alone must not call the model — only
    // clicking Parse does — so this runs without any GEMINI key.
    //
    // The filename MUST be unique. The E2E fixture already ships a document
    // called "receipt.png", and AttachmentsPanel checks for a duplicate
    // filename before uploading: a collision opens an "Attach existing /
    // Upload new copy" prompt and the upload never completes, so the Parse
    // button never renders. That is duplicate detection working correctly —
    // the spec was simply asking for a name the fixture already owned.
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const filename = `e2e-parse-${Date.now()}.png`;
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: filename,
      mimeType: "image/png",
      buffer: onePixelPng,
    });

    // Prove the upload actually completed rather than stalling on a prompt.
    await expect(page.getByText(filename).first()).toBeVisible({ timeout: 15000 });

    await expect(page.getByRole("button", { name: /parse with ai/i }).first()).toBeVisible({
      timeout: 15000,
    });
  });
});
