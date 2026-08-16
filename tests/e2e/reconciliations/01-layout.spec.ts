import { test, expect } from "@playwright/test";

const RECON_ID = "5b6077b6-3ae3-437d-95ab-7281455d8494";

test.describe("Reconciliation Layout & Navigation", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto(`/reconciliations/${RECON_ID}`);
    await expect(page.getByRole("heading", { name: /Mercury Checking 1231/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("should render the fundamental header structure", async ({ page }) => {
    // Heading
    await expect(page.getByRole("heading", { name: /Mercury Checking 1231/i })).toBeVisible();

    // Status Badge
    await expect(page.getByText("In Progress")).toBeVisible();

    // View/Edit toggle is present and view is active
    const viewBtn = page.getByRole("button", { name: "View", exact: true });
    const editBtn = page.getByRole("button", { name: "Edit", exact: true });

    await expect(viewBtn).toBeVisible();
    await expect(editBtn).toBeVisible();
    await expect(viewBtn).toHaveClass(/bg-white|shadow-sm/); // Active class
  });

  test("should toggle the left document viewer panel", async ({ page }) => {
    // Assert toggle is in "show" state by default (meaning it can be hidden)
    const hideBtn = page.getByRole("button", { name: "Hide Document Viewer" });
    const showBtn = page.getByRole("button", { name: "Show Document Viewer" });

    await expect(hideBtn).toBeVisible();

    // Hide
    await hideBtn.click();
    await expect(showBtn).toBeVisible();
    await expect(hideBtn).not.toBeVisible();

    // Show
    await showBtn.click();
    await expect(hideBtn).toBeVisible();
  });

  test("should toggle the right sidebar panel", async ({ page }) => {
    // Assert panel is visible initially (desktop)
    const summaryBtn = page.getByRole("button", { name: "Summary" });
    await expect(summaryBtn).toBeVisible();

    // Hide
    await page.getByTitle("Hide Sidebar").click();
    await expect(summaryBtn).not.toBeVisible();

    // Show
    await page.getByTitle("Show Sidebar").click();
    await expect(summaryBtn).toBeVisible();
  });

  test("should display summary metrics and status counters", async ({ page }) => {
    // Summary Row labels in center panel
    await expect(page.getByText("Deposits", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Withdrawals", { exact: true }).first()).toBeVisible();

    // Status counters
    await expect(page.getByTitle("Filter reconciled")).toBeVisible();
    await expect(page.getByTitle("Filter unsettled")).toBeVisible();
  });
});
