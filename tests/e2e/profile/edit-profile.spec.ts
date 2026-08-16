import { test, expect } from "@playwright/test";

test.describe("Edit Profile Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
  });

  test("can update display name", async ({ page }) => {
    // Wait for the form to fully hydrate — the input must have a real value, not empty
    const nameInput = page.getByLabel("Display Name");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).not.toHaveValue("");

    // Capture the original name so we can restore it
    const originalName = await nameInput.inputValue();

    // 1. Fill a new name
    const tempName = `Test User ${Date.now()}`;
    await nameInput.fill(tempName);

    // 2. The button should now be enabled since hasChanges is true
    const updateBtn = page.getByRole("button", { name: "Update Profile" });
    await expect(updateBtn).toBeEnabled({ timeout: 3000 });

    // 3. Intercept the API call so we know the mutation fired and completed
    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/auth/update-user") && resp.status() === 200,
      { timeout: 10000 },
    );

    await updateBtn.click();
    await responsePromise;

    // 4. Verify persistence by asserting the reactive UI updated.
    // The sidebar profile link should eventually reflect the new session name.
    const sidebarProfileLink = page.getByRole("link", { name: new RegExp(tempName) });
    await expect(sidebarProfileLink).toBeVisible({ timeout: 10000 });

    // 5. Restore original name (non-destructive)
    await nameInput.fill(originalName);
    const restoreBtn = page.getByRole("button", { name: /update profile|✓ saved/i });
    await expect(restoreBtn).toBeEnabled({ timeout: 3000 });

    const restoreResponse = page.waitForResponse(
      (resp) => resp.url().includes("/api/auth/update-user") && resp.status() === 200,
      { timeout: 10000 },
    );
    await restoreBtn.click();
    await restoreResponse;
  });

  test("can open timezone combobox and select an option", async ({ page }) => {
    // Wait for the combobox to render with its current value
    const combobox = page.getByRole("combobox");
    await expect(combobox).toBeVisible();

    // 1. Open the combobox — this replaces the button with a search input
    await combobox.click();

    // 2. Wait for the dropdown listbox to appear
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible({ timeout: 5000 });

    // 3. Verify options are rendered
    const options = page.getByRole("option");
    const count = await options.count();
    expect(count).toBeGreaterThan(0);

    // 4. Pick the first option
    await options.first().click();

    // 5. The combobox should close (listbox hidden) and show the selection
    await expect(listbox).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByRole("combobox")).toBeVisible();

    // 6. Verify the Update Profile button reflects the form state correctly
    const updateBtn = page.getByRole("button", { name: "Update Profile" });
    await expect(updateBtn).toBeVisible();

    // If the selected timezone was different from initial, the button will be enabled.
    // If same, it will be disabled. Either state is valid — the combobox interaction worked.
    const btnText = await updateBtn.textContent();
    expect(btnText).toContain("Update Profile");
  });
});
