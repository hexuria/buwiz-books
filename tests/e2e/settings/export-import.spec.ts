import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

/**
 * Export / Import E2E Tests
 *
 * Non-destructive: export tests are read-only, import tests verify up to
 * the validation preview step but never execute actual imports.
 */
test.describe("Settings Export & Import", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "Export / Import", exact: true }).click();
    // Wait for the export panel to render
    await expect(page.getByText("Select Data to Export")).toBeVisible();
  });

  // ════════════════════════════════════════════════════════════════════════
  // Export Panel
  // ════════════════════════════════════════════════════════════════════════

  test.describe("Export Panel", () => {
    test("should display all entity types with checkboxes", async ({ page }) => {
      // Scope to the main content area to avoid matching the settings sidebar heading
      const main = page.getByRole("main");

      const expectedLabels = [
        "Categories (COA)",
        "Departments",
        "Locations",
        "Products & Services",
        "Vendors",
        "Customers",
        "Employees",
        "Shareholders",
        "Lenders",
        "Government",
        "Banks & Cards",
        "Transactions",
        "Bills (A/P)",
        "Invoices (A/R)",
        "Number Sequences",
      ];

      for (const label of expectedLabels) {
        await expect(main.getByText(label, { exact: true })).toBeVisible();
      }

      // "Organization Settings" exists but may clash with the page heading.
      // Verify the entity row exists by checking within the checklist section
      const entityList = main.locator(".divide-y");
      await expect(entityList.getByText("Organization Settings")).toBeVisible();
    });

    test("should show format selector with JSON and CSV options", async ({ page }) => {
      // The format labels are <label> elements containing a radio + <span> text
      const main = page.getByRole("main");
      await expect(main.getByText("Format:")).toBeVisible();
      // Use radio inputs by name attribute to verify format options
      const jsonRadio = main.locator('input[type="radio"][value="json"]');
      const csvRadio = main.locator('input[type="radio"][value="csv"]');
      await expect(jsonRadio).toBeAttached();
      await expect(csvRadio).toBeAttached();
      // JSON should be the default selection
      await expect(jsonRadio).toBeChecked();
    });

    test("should show Select All and Deselect All controls", async ({ page }) => {
      await expect(page.getByText("Select All", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Deselect All", { exact: true }).first()).toBeVisible();
    });

    test("should have include inactive toggle", async ({ page }) => {
      await expect(page.getByText(/Include inactive records/i)).toBeVisible();
    });

    test("should export selected entities as JSON and produce valid v2 file", async ({ page }) => {
      // Deselect all first
      await page.getByText("Deselect All", { exact: true }).first().click();

      // Re-select only Categories and Departments by clicking the label text
      // The entity checklist is a list of rows with <input type="checkbox"> + <span> label
      const entityList = page.getByRole("main").locator(".divide-y");

      // Check categories
      const catRow = entityList
        .locator("div")
        .filter({ hasText: /^Categories \(COA\)/ })
        .first();
      await catRow.locator('input[type="checkbox"]').check();

      // Check departments
      const deptRow = entityList
        .locator("div")
        .filter({ hasText: /^Departments/ })
        .first();
      await deptRow.locator('input[type="checkbox"]').check();

      // Click Export and capture the download
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: /Export Selected/i }).click();
      const download = await downloadPromise;

      // Verify filename
      const filename = download.suggestedFilename();
      expect(filename).toMatch(/^export-\d{4}-\d{2}-\d{2}\.json$/);

      // Read and parse the downloaded file
      const filePath = path.join("/tmp", `e2e-export-${Date.now()}.json`);
      await download.saveAs(filePath);
      const content = fs.readFileSync(filePath, "utf-8");
      const exported = JSON.parse(content);

      // Verify v2 format with meta block
      expect(exported.meta).toBeDefined();
      expect(exported.meta.version).toBe(2);
      expect(typeof exported.meta.exportedAt).toBe("string");
      expect(typeof exported.meta.organizationName).toBe("string");
      expect(exported.meta.organizationSlug).toBeDefined();
      expect(Array.isArray(exported.meta.entities)).toBe(true);
      expect(exported.meta.entities).toContain("categories");
      expect(exported.meta.entities).toContain("departments");

      // Verify data block
      expect(exported.data).toBeDefined();
      expect(Array.isArray(exported.data.categories)).toBe(true);
      expect(exported.data.categories.length).toBeGreaterThan(0);
      expect(Array.isArray(exported.data.departments)).toBe(true);

      // Verify a category has expected fields
      const firstCat = exported.data.categories[0];
      expect(firstCat).toHaveProperty("name");
      expect(firstCat).toHaveProperty("accountType");

      // Cleanup
      fs.unlinkSync(filePath);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Import Panel
  // ════════════════════════════════════════════════════════════════════════

  test.describe("Import Panel", () => {
    test.beforeEach(async ({ page }) => {
      // The tab buttons are pill buttons with text "Export" and "Import" inside <span>
      // Click the "Import" pill button
      const importTab = page
        .locator("button")
        .filter({ hasText: /^Import$/ })
        .first();
      await importTab.click();
      // Wait for import panel content — use heading role to avoid matching description text
      await expect(page.getByRole("heading", { name: "Import Data" })).toBeVisible();
    });

    test("should display all importable entity types in dropdown", async ({ page }) => {
      const select = page.locator("select");
      await expect(select).toBeVisible();

      const expectedOptions = [
        "Banks & Cards",
        "Vendors",
        "Customers",
        "Employees",
        "Shareholders",
        "Lenders",
        "Government",
        "Categories (COA)",
        "Departments",
        "Locations",
        "Products & Services",
      ];

      for (const opt of expectedOptions) {
        await expect(select.locator("option", { hasText: opt })).toBeAttached();
      }
    });

    test("should show file upload zone with accepted formats", async ({ page }) => {
      await expect(page.getByText(/Drop file here or click to upload/i)).toBeVisible();
      await expect(page.getByText(/Accepts .json or .csv files/i)).toBeVisible();
    });

    test("should validate an uploaded valid JSON file and show preview", async ({ page }) => {
      // Select entity type
      const select = page.locator("select");
      await select.selectOption("categories");

      // Create a small test fixture
      const testData = [
        {
          accountNumber: "99001",
          name: "E2E Test Category Alpha",
          accountType: "expense",
          description: "Test category for E2E",
          isActive: true,
        },
        {
          accountNumber: "99002",
          name: "E2E Test Category Beta",
          accountType: "expense",
          description: "Another test category",
          isActive: true,
        },
      ];

      // Upload via fileChooser
      const fileChooserPromise = page.waitForEvent("filechooser");
      await page.getByText(/Drop file here or click to upload/i).click();
      const fileChooser = await fileChooserPromise;
      const tmpFile = path.join("/tmp", `e2e-import-test-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(testData));
      await fileChooser.setFiles(tmpFile);

      // Wait for validation response
      await page.waitForResponse((r) => r.url().includes("serverFn") && r.status() === 200, {
        timeout: 15000,
      });

      // Verify validation preview shows correct counts
      await expect(page.getByText("2", { exact: true }).first()).toBeVisible();

      // Verify Import button is visible — but DO NOT click it (non-destructive)
      const importBtn = page.getByRole("button", { name: /Import.*Valid/i });
      await expect(importBtn).toBeVisible();
      await expect(importBtn).toBeEnabled();

      // Cleanup
      fs.unlinkSync(tmpFile);
    });

    test("should show validation errors for invalid bank rows", async ({ page }) => {
      // Select banks entity type
      const select = page.locator("select");
      await select.selectOption("banks");

      // Create invalid data (missing accountName and accountType)
      const invalidData = [
        { institutionName: "Bad Bank" },
        { accountName: "", accountType: "checking" },
      ];

      const fileChooserPromise = page.waitForEvent("filechooser");
      await page.getByText(/Drop file here or click to upload/i).click();
      const fileChooser = await fileChooserPromise;
      const tmpFile = path.join("/tmp", `e2e-import-invalid-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(invalidData));
      await fileChooser.setFiles(tmpFile);

      // Wait for validation
      await page.waitForResponse((r) => r.url().includes("serverFn") && r.status() === 200, {
        timeout: 15000,
      });

      // Verify the preview shows invalid rows
      // The "invalid" count badge should be visible
      await expect(page.getByText(/invalid/i).first()).toBeVisible();

      // Cleanup
      fs.unlinkSync(tmpFile);
    });
  });
});
