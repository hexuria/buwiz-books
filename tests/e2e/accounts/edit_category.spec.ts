import { test, expect } from "@playwright/test";

test.describe("Edit Category Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("can open edit category form from detail view and save modifications", async ({ page }) => {
    // Side panel (detail/form) is inside div.hidden.lg:block
    const desktopPanel = page.locator("div.hidden.lg\\:block");

    // Category rows are in the main list panel (NOT inside desktopPanel)
    const firstRow = page.locator(".group.grid").first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();

    // Click the edit button (pencil icon with title="Edit")
    const editBtn = desktopPanel.locator('button[title="Edit"]');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    await expect(page).toHaveURL(/.*mode=edit.*/);
    await expect(desktopPanel.getByText("Edit Category", { exact: true })).toBeVisible();

    // Verify deactivate/activate button is present
    await expect(
      desktopPanel.getByRole("button", {
        name: /Deactivate Category|Activate Category/i,
      }),
    ).toBeVisible();

    // Modify the description
    const newDesc = `Updated via E2E ${Date.now()}`;
    await desktopPanel.getByPlaceholder("Enter a description...").fill(newDesc);

    // Save — wait for the API response before asserting
    const saveResponse = page.waitForResponse(
      (r) => r.url().includes("serverFn") && r.status() === 200,
    );
    await desktopPanel.getByRole("button", { name: "Save" }).click();
    await saveResponse;

    // After save, mode should be cleared
    await expect(page).not.toHaveURL(/.*mode=edit.*/);
    // Edit button should be visible again in the detail view
    await expect(editBtn).toBeVisible();

    // Description text should now be visible on the detail panel
    await expect(desktopPanel.getByText(newDesc)).toBeVisible();
  });
});
