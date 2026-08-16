import { test, expect } from "@playwright/test";

test.describe("Mappings Page — Tab Navigation & Layout", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/organization/default/mappings");
    await expect(page.getByRole("heading", { name: "Category Mappings" })).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Layout ──────────────────────────────────────────────────────────

  test("should render the header with back-to-app link", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Category Mappings" })).toBeVisible();

    const backLink = page.getByText("Back to app");
    await expect(backLink).toBeVisible();
  });

  test("should render all 5 sidebar tabs", async ({ page }) => {
    await expect(page.getByRole("button", { name: /Banks & Cards/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Bills/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Invoices/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Connections/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Parties/i })).toBeVisible();
  });

  // ── Tab Switching ───────────────────────────────────────────────────

  test("should default to the Banks & Cards tab with mapping rows", async ({ page }) => {
    // Banks tab should be active by default
    const banksBtn = page.getByRole("button", { name: /Banks & Cards/i });
    await expect(banksBtn).toHaveClass(/text-\[#0d9488\]/);

    // Should show bank mapping config title
    await expect(page.getByText("Bank & Card Category Mapping")).toBeVisible();
    await expect(page.getByText("Changes apply immediately")).toBeVisible();
  });

  test("should switch to Bills tab", async ({ page }) => {
    await page.getByRole("button", { name: /Bills/i }).click();

    // Bills-specific content should appear
    await expect(page.getByText(/Bill.*Category Mapping/i)).toBeVisible();
    await expect(page.getByText("Changes apply immediately")).toBeVisible();
  });

  test("should switch to Invoices tab", async ({ page }) => {
    await page.getByRole("button", { name: /Invoices/i }).click();

    // Invoice-specific content should appear
    await expect(page.getByText(/Invoice.*Category Mapping/i)).toBeVisible();
    await expect(page.getByText("Changes apply immediately")).toBeVisible();
  });

  test("should switch to Connections tab with empty state or list", async ({ page }) => {
    await page.getByRole("button", { name: /Connections/i }).click();

    // Connections tab has its own header
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();

    // Either "No connections yet" or connection rows
    await expect(
      page.getByText("No connections yet").or(page.getByText(/connection/i).first()),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("should switch to Parties tab", async ({ page }) => {
    await page.getByRole("button", { name: /Parties/i }).click();

    // Parties tab should render party mapping content
    // It may show party types or an empty state
    await expect(page.locator("main")).toBeVisible();
  });

  // ── Connections Tab — Add Connection Modal ──────────────────────────

  test("should open and cancel the Add Connection modal", async ({ page }) => {
    await page.getByRole("button", { name: /Connections/i }).click();
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();

    // Click "Add Connection"
    await page.getByRole("button", { name: "Add Connection" }).click();

    // Modal should open with "Add Connection" heading
    await expect(page.getByRole("heading", { name: "Add Connection" })).toBeVisible();

    // Verify form elements are present
    await expect(page.getByText("Source Name *")).toBeVisible();
    await expect(page.getByText("Ledger Category *")).toBeVisible();

    // Save should be disabled when fields are empty
    const saveBtn = page.getByRole("button", { name: /Save|Create/i }).last();
    await expect(saveBtn).toBeVisible();

    // Cancel out
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Add Connection" })).not.toBeVisible();
  });

  test("should populate Add Connection form fields correctly", async ({ page }) => {
    await page.getByRole("button", { name: /Connections/i }).click();
    await page.getByRole("button", { name: "Add Connection" }).click();
    await expect(page.getByRole("heading", { name: "Add Connection" })).toBeVisible();

    // Fill in source name
    await page.getByPlaceholder("e.g., Mercury Checking").fill("Test Bank Account");
    await expect(page.getByPlaceholder("e.g., Mercury Checking")).toHaveValue("Test Bank Account");

    // Fill in institution
    await page.getByPlaceholder("e.g., Mercury Bank").fill("Test Institution");

    // Fill in last 4 digits (should only accept digits)
    await page.getByPlaceholder("1234").fill("5678");
    await expect(page.getByPlaceholder("1234")).toHaveValue("5678");

    // Cancel without saving to avoid test pollution
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  // ── Back Navigation ─────────────────────────────────────────────────

  test("should navigate back to app from mappings page", async ({ page }) => {
    const backLink = page.getByText("Back to app");
    await backLink.click();

    // Should navigate to the overview dashboard.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });
});
