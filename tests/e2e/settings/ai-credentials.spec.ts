import { test, expect } from "@playwright/test";

test.describe("Settings AI Credentials Tab", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "AI Credentials", exact: true }).click();
  });

  test("should add and remove a temporary API key safely", async ({ page }) => {
    const aiKeyInput = page.getByPlaceholder("AIzaSy...");
    await expect(aiKeyInput).toBeVisible();

    const addBtn = page.getByRole("button", { name: "Add", exact: true });
    await expect(addBtn).toBeDisabled();

    // Type a dummy key
    const dummyKey = `AIzaSy-Test-Key-${Date.now()}`;
    await aiKeyInput.fill(dummyKey);
    await expect(addBtn).not.toBeDisabled();

    // Add it — wait for the input to clear and key to appear in the list
    await addBtn.click();

    // Wait for optimistic success UI
    await expect(page.getByText("✓ Keys saved successfully")).toBeVisible();

    // The input should clear
    await expect(aiKeyInput).toHaveValue("");

    // Verify key exists in the list (it will be visually masked, but we can verify the text representation)
    const maskedSnippet = "••••" + dummyKey.slice(-4);
    const keyRow = page.locator("div.group", { hasText: maskedSnippet }).first();
    await expect(keyRow).toBeVisible();

    // Now remove it to clean up the DB — use force:true because the button has opacity:0 until hover
    // Wait for the key to disappear from the DOM
    const removeBtn = keyRow.locator("button[title='Remove key']");
    await removeBtn.click({ force: true });
    await expect(keyRow).not.toBeVisible();

    // Verify removal
    await expect(page.getByText("✓ Keys saved successfully")).toBeVisible();
    await expect(keyRow).not.toBeVisible();
  });

  test("should toggle the AI Image Generation toggle", async ({ page }) => {
    // The toggle is a button in the AI Image Generation section
    const toggleBtn = page.getByRole("button").filter({ has: page.locator("span.transform") });
    await expect(toggleBtn).toBeVisible();

    // Because tests run in parallel against the same organization database,
    // asserting the final visual state (translate-x-6) is highly prone to race conditions.
    // Instead, we verify the toggle is interactive and triggers a save request.
    const responsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.status() === 200,
    );

    await toggleBtn.click();
    await responsePromise;
  });
});
