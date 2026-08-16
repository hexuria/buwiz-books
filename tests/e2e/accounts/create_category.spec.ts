import { test, expect } from "@playwright/test";

test.describe("Create Category Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("can open new category form and verify fields", async ({ page }) => {
    // "New Category" button is in the top nav, outside the dual-panel
    await page.getByRole("button", { name: "New Category", exact: true }).first().click();
    await expect(page).toHaveURL(/.*mode=create.*/);

    // Scope all form assertions to the desktop side-panel container
    // The layout renders sidePanel twice: desktop (.hidden.lg:block) and mobile (.lg:hidden)
    const desktopPanel = page.locator("div.hidden.lg\\:block");

    const header = desktopPanel.getByText("New Category", { exact: true });
    await expect(header).toBeVisible();

    await expect(desktopPanel.getByPlaceholder("Enter category name...")).toBeVisible();
    await expect(
      desktopPanel.getByRole("button", { name: "No parent (root level)", exact: true }),
    ).toBeVisible();
    await expect(
      desktopPanel
        .getByRole("button", { name: /Select type.../i })
        .or(desktopPanel.getByRole("button", { name: "Asset" })),
    ).toBeVisible();
    await expect(desktopPanel.getByRole("button", { name: /Select subtype.../i })).toBeVisible();

    await expect(desktopPanel.getByText("Icon", { exact: true })).toBeVisible();
    await expect(desktopPanel.getByPlaceholder("Auto-generated")).toBeVisible();
    await expect(desktopPanel.getByPlaceholder("Enter a description...")).toBeVisible();

    await expect(desktopPanel.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(desktopPanel.getByRole("button", { name: "Create" })).toBeVisible();
  });

  test("can interact with new category form and cancel", async ({ page }) => {
    const catName = `Test Simple Cat ${Date.now()}`;

    await page.getByRole("button", { name: "New Category", exact: true }).first().click();

    // Scope to desktop panel
    const desktopPanel = page.locator("div.hidden.lg\\:block");

    await desktopPanel.getByPlaceholder("Enter category name...").fill(catName);
    await desktopPanel
      .getByPlaceholder("Enter a description...")
      .fill("Testing interaction without saving");

    // Click Cancel instead of Create to keep tests non-destructive and prevent DB state leakages
    await desktopPanel.getByRole("button", { name: "Cancel" }).click();

    // After cancellation, the mode param should be cleared
    await expect(page).not.toHaveURL(/.*mode=create.*/);

    // Ensure form is no longer visible
    await expect(desktopPanel.getByPlaceholder("Enter category name...")).not.toBeVisible();
  });
});
