import { test, expect } from "@playwright/test";

test.describe("Delete Category Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("can delete a sub-category safely and displays correct modal constraints", async ({
    page,
  }) => {
    const tempCatName = `To Be Deleted ${Date.now()}`;

    // Scope form interactions to the desktop side-panel
    const desktopPanel = page.locator("div.hidden.lg\\:block");

    // 1. Create a sub-category
    await page.getByRole("button", { name: "New Category", exact: true }).first().click();
    await desktopPanel.getByPlaceholder("Enter category name...").fill(tempCatName);

    // Open parent picker and wait for dropdown to render before selecting
    await desktopPanel.getByRole("button", { name: "No parent (root level)", exact: true }).click();
    const assetsOption = desktopPanel.getByRole("button", { name: "10000 - Assets" });
    await expect(assetsOption).toBeVisible();
    await assetsOption.click();

    // Wait for the API response after clicking Create
    const createResponse = page.waitForResponse(
      (r) => r.url().includes("serverFn") && r.status() === 200,
    );
    await desktopPanel.getByRole("button", { name: "Create" }).click();
    await createResponse;

    // 2. Verify creation succeeded — URL should no longer have mode=create
    await expect(page).not.toHaveURL(/.*mode=create.*/);
    await expect(desktopPanel.getByText(tempCatName).first()).toBeVisible();

    // 3. Click the trash (delete) icon — it's a small icon-only button
    //    Use page-level locator with force:true to bypass potential overlay issues
    const deleteBtn = desktopPanel.getByRole("button", { name: "Delete" });
    await expect(deleteBtn).toBeEnabled();
    await deleteBtn.click({ force: true });

    // 4. Verify the Delete confirmation modal appears (portaled to body)
    const modalHeading = page.getByRole("heading", { name: "Delete Category" });
    await expect(modalHeading).toBeVisible({ timeout: 5000 });

    // 5. Confirm Delete
    const confirmBtn = page.getByRole("button", { name: "Delete" }).last();
    await confirmBtn.click();

    // 6. Modal should vanish
    await expect(modalHeading).toBeHidden();

    // 7. The detail panel should reset to the empty "Filter by Type" view
    await expect(desktopPanel.getByText("Filter by Type")).toBeVisible();
    await expect(page.getByText(tempCatName)).toBeHidden();
  });
});
