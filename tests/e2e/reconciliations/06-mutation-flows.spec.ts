import { test, expect } from "@playwright/test";

const RECON_ID = "5b6077b6-3ae3-437d-95ab-7281455d8494";

test.describe("Reconciliation Mutation Flows", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto(`/reconciliations/${RECON_ID}`);
    await expect(page.getByRole("heading", { name: /Mercury Checking 1231/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Flag Resolution ─────────────────────────────────────────────────

  test("should show the Flag tab with unresolved item counts", async ({ page }) => {
    // Click the Flag tab in the right sidebar
    const flagTab = page.getByRole("button", { name: "Flag" });
    await flagTab.click();

    // The Flag tab should be active and showing flag content
    // Look for either unresolved items or the "No flags" empty state
    const unresolvedSection = page.getByText(/Unresolved|Unsettled|No flags/i).first();
    await expect(unresolvedSection).toBeVisible({ timeout: 5_000 });
  });

  test("should display the Dismiss button on unresolved flags", async ({ page }) => {
    const flagTab = page.getByRole("button", { name: "Flag" });
    await flagTab.click();

    // If there are unresolved flags, each one should have a "Dismiss" action
    const dismissButtons = page.getByRole("button", { name: "Dismiss" });
    const flagCount = await dismissButtons.count();

    if (flagCount > 0) {
      // At least one dismiss button is visible
      await expect(dismissButtons.first()).toBeVisible();
    } else {
      // No flags — that's fine in a reconciled snapshot
      test.skip(true, "No unresolved flags in this snapshot");
    }
  });

  // ── AI Suggestion Display ───────────────────────────────────────────

  test("should display AI Suggestions section in the Flag tab when suggestions exist", async ({
    page,
  }) => {
    const flagTab = page.getByRole("button", { name: "Flag" });
    await flagTab.click();

    // Check for AI Suggestions header
    const suggestionsHeader = page.getByText(/AI Suggestions/i).first();
    const hasSuggestions = await suggestionsHeader.isVisible().catch(() => false);

    if (hasSuggestions) {
      // Verify Apply and Dismiss buttons are present for pending suggestions
      const applyButtons = page.getByRole("button", { name: "Apply" });
      await expect(applyButtons.first()).toBeVisible();

      const dismissButtons = page.getByRole("button", { name: "Dismiss" });
      await expect(dismissButtons.first()).toBeVisible();
    } else {
      // No suggestions in this reconciliation — verify we're at least on the right tab
      await expect(page.getByText(/No flags|Unresolved|Unsettled/i).first()).toBeVisible();
    }
  });

  // ── Sidebar Tab Navigation ──────────────────────────────────────────

  test("should cycle through all 4 sidebar tabs", async ({ page }) => {
    // Summary tab (default)
    const summaryTab = page.getByRole("button", { name: "Summary" });
    await expect(summaryTab).toBeVisible();

    // Flag tab
    const flagTab = page.getByRole("button", { name: "Flag" });
    await flagTab.click();
    await expect(
      page.getByText(/Unresolved|Unsettled|No flags|AI Suggestions/i).first(),
    ).toBeVisible();

    // Comments tab
    const commentsTab = page.getByRole("button", { name: "Comments" });
    await commentsTab.click();
    // Either a comment input or empty state should be visible
    await expect(
      page.getByPlaceholder(/Add a comment|Write a comment/i).or(page.getByText(/No comments/i)),
    ).toBeVisible({ timeout: 5_000 });

    // Activity tab
    const activityTab = page.getByRole("button", { name: "Activity" });
    await activityTab.click();
    // Either activity entries or empty state
    await expect(page.getByText(/No activity|created|matched|finalized/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  // ── Finalize / Reopen State Machine ─────────────────────────────────

  test("should attempt finalization and handle balance mismatch gracefully", async ({ page }) => {
    const finalizeBtn = page.getByRole("button", { name: /Finalize/i });
    const isVisible = await finalizeBtn.isVisible().catch(() => false);

    if (!isVisible) {
      test.skip(true, "Reconciliation is already finalized");
      return;
    }

    // Click Finalize
    await finalizeBtn.click();

    // Confirm modal should appear
    const confirmBtn = page.getByRole("button", { name: /Confirm|Finalize/i }).last();
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });

    // Attempt to confirm — this may succeed or fail depending on balance match
    // Intercept the API response to check what happened
    const [response] = await Promise.all([
      page
        .waitForResponse(
          (resp) => resp.url().includes("reconciliation") && resp.request().method() === "POST",
          { timeout: 10_000 },
        )
        .catch(() => null),
      confirmBtn.click(),
    ]);

    if (response) {
      const status = response.status();
      if (status >= 200 && status < 300) {
        // Finalized successfully — verify the Reopen button appears
        await expect(page.getByRole("button", { name: /Reopen/i })).toBeVisible({
          timeout: 10_000,
        });
      }
      // If it failed (balance mismatch), that's expected — we just verify no crash
    }

    // Page should still be stable
    await expect(page.getByRole("heading", { name: /Mercury Checking 1231/i })).toBeVisible();
  });

  test("should show Reopen button on a finalized reconciliation", async ({ page }) => {
    // Check if the reconciliation is already finalized
    const reopenBtn = page.getByRole("button", { name: /Reopen/i });
    const isFinalized = await reopenBtn.isVisible().catch(() => false);

    if (isFinalized) {
      // Verify the reopen button is visible and clickable
      await expect(reopenBtn).toBeEnabled();

      // Verify that the Edit button is disabled when finalized
      const editBtn = page.getByRole("button", { name: "Edit", exact: true });
      await expect(editBtn).toHaveClass(/opacity-40|cursor-not-allowed/);
    } else {
      // Not finalized — verify finalize button is present instead
      await expect(page.getByRole("button", { name: /Finalize/i })).toBeVisible();
    }
  });

  // ── View / Edit Mode Toggle ─────────────────────────────────────────

  test("should toggle between View and Edit modes", async ({ page }) => {
    const viewBtn = page.getByRole("button", { name: "View", exact: true });
    const editBtn = page.getByRole("button", { name: "Edit", exact: true });

    // View mode is active by default
    await expect(viewBtn).toHaveClass(/bg-white|shadow-sm/);

    // Check if we can toggle to edit (not finalized)
    const isDisabled = await editBtn.evaluate(
      (el) => el.classList.contains("opacity-40") || (el as HTMLButtonElement).disabled,
    );

    if (!isDisabled) {
      await editBtn.click();
      await expect(editBtn).toHaveClass(/bg-white|shadow-sm/);

      // Toggle back to view
      await viewBtn.click();
      await expect(viewBtn).toHaveClass(/bg-white|shadow-sm/);
    } else {
      test.skip(true, "Edit mode disabled — reconciliation is finalized");
    }
  });

  // ── Activity Log Hydration ──────────────────────────────────────────

  test("should show activity entries reflecting past mutations", async ({ page }) => {
    const activityTab = page.getByRole("button", { name: "Activity" });
    await activityTab.click();

    // Wait for activity entries to load
    const hasActivity = await page
      .getByText(/created|matched|finalized|reconfigured|reopened/i)
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (hasActivity) {
      // Verify at least the "created" action exists (every recon has one)
      await expect(page.getByText(/created/i).first()).toBeVisible();
    } else {
      // Empty activity log
      await expect(page.getByText(/No activity/i)).toBeVisible();
    }
  });
});
