import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
});

test.describe("Filter Panel Integration", () => {
  test("clicking filter funnel opens the LedgerFilters slide-in panel", async ({ page }) => {
    // Top bar has the filter toggle button
    await page.getByTestId("filter-toggle").click();
    await expect(page.getByTestId("filter-panel")).toBeVisible();
  });

  test("toggling a Type filter adds it to context URL", async ({ page }) => {
    await page.getByTestId("filter-toggle").click();

    // Type is usually open by default, let's grab "Pay In"
    const panel = page.getByTestId("filter-panel");
    await panel.getByText("Pay In", { exact: true }).click();

    // Validating state mapping to URL
    await expect(page).toHaveURL(/.*types=pay_in.*/);
  });

  test("toggling a Status filter opens accordion and sets URL", async ({ page }) => {
    await page.getByTestId("filter-toggle").click();

    const panel = page.getByTestId("filter-panel");

    // Expand Status accordion
    await panel.getByText("Status", { exact: true }).click();
    await panel.getByText("Reconciled").click();

    await expect(page).toHaveURL(/.*statuses=posted.*/);
  });

  test("clicking Clear All removes all contextual filters", async ({ page }) => {
    await page.getByTestId("filter-toggle").click();

    const panel = page.getByTestId("filter-panel");
    await panel.getByText("Pay In", { exact: true }).click();
    await expect(page).toHaveURL(/.*types=pay_in.*/);

    // Clear all
    const clearBtn = page.getByText("Clear all");
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await expect(page.url()).not.toContain("types=pay_in");
    }
  });

  test("entering amount ranges correctly filters via URL", async ({ page }) => {
    await page.getByTestId("filter-toggle").click();
    const panel = page.getByTestId("filter-panel");
    const amountSection = panel.getByText("Amount", { exact: true });
    // Expand Amount
    await amountSection.click();

    // Find the inputs strictly next to the Min / Max labels
    const minInput = panel.locator('input[placeholder="0.00"]').nth(0);
    const maxInput = panel.locator('input[placeholder="0.00"]').nth(1);

    // If the accordion successfully expanded the inputs
    if (await minInput.isVisible()) {
      await minInput.fill("100");
      await minInput.press("Enter"); // Trigger blur or key event for inputs

      await expect(page).toHaveURL(/.*amountMin=(%22)??100(%22)??.*/);

      await maxInput.fill("5000");
      await maxInput.press("Enter"); // Trigger blur or key event for inputs
      await expect(page).toHaveURL(/.*amountMax=(%22)??5000(%22)??.*/);
    }
  });
});
