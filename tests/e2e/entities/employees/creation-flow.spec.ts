import { test, expect } from "@playwright/test";

test.describe("Employees Creation Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/employees");
    await page.waitForLoadState("networkidle");
  });

  test("should open the creation form and cancel", async ({ page }) => {
    // Click Add Employee
    const newEmployeeBtn = page.getByRole("button", { name: "Add Employee" }).first();
    await newEmployeeBtn.click();

    // Check if the panel opens
    const panelHeader = page.getByText("New Employee", { exact: true }).first();
    await expect(panelHeader).toBeVisible();

    // Locate form fields
    const nameInput = page.getByPlaceholder("Employee name").first();
    await expect(nameInput).toBeVisible();

    // Try Cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    // Panel might close or revert to default header
    await expect(nameInput).not.toBeVisible();
  });

  test("should interact with creation fields without saving", async ({ page }) => {
    const newEmployeeBtn = page.getByRole("button", { name: "Add Employee" }).first();
    await newEmployeeBtn.click();

    // Fill standard fields
    await page.getByPlaceholder("Employee name").first().fill("E2E Test Employee");
    await page.getByPlaceholder("email@example.com").first().fill("e2e@test.com");
    await page.getByPlaceholder("(555) 123-4567").first().fill("5551234567");
    await page.getByPlaceholder("https://example.com").first().fill("https://e2e.test");

    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });
});
