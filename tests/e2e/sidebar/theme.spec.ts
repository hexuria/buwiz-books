import { test, expect } from "@playwright/test";

test.describe("Sidebar Theme Preferences", () => {
  // Use the standard authorized user session
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Navigate to a page that reliably renders the AppSidebar
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
  });

  test("can toggle dark mode and persist selection", async ({ page }) => {
    // 1. Click Dark mode
    await page.getByRole("button", { name: "Dark" }).click();

    // 2. HTML element should receive dark class and data-theme attribute natively
    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-theme", "dark");

    // 3. Verify LocalStorage is saved
    const themeStorage = await page.evaluate(() => localStorage.getItem("buwiz-theme"));
    expect(themeStorage).toBe("dark");

    // 4. Reload page to confirm persistence
    await page.reload();
    await page.waitForLoadState("networkidle");

    // 5. HTML should still have the dark class after reload
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("can toggle light mode", async ({ page }) => {
    const html = page.locator("html");

    // 1. First set it to dark to ensure a state change
    await page.getByRole("button", { name: "Dark" }).click();
    await expect(html).toHaveClass(/dark/);

    // 2. Click Light mode
    await page.getByRole("button", { name: "Light" }).click();

    // 3. Verify HTML class is removed and attribute is updated
    await expect(html).not.toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-theme", "light");

    // 4. Verify LocalStorage
    const themeStorage = await page.evaluate(() => localStorage.getItem("buwiz-theme"));
    expect(themeStorage).toBe("light");
  });

  test("can sync dynamically with system preferences", async ({ page }) => {
    const html = page.locator("html");

    // 1. Force the page to a known state: Dark mode
    await page.getByRole("button", { name: "Dark" }).click();
    await expect(html).toHaveClass(/dark/);

    // 2. Select System theme
    await page.getByRole("button", { name: "System" }).click();

    // 3. LocalStorage should reflect 'system'
    const themeStorage = await page.evaluate(() => localStorage.getItem("buwiz-theme"));
    expect(themeStorage).toBe("system");

    // 4. Emulate system preference -> Dark
    await page.emulateMedia({ colorScheme: "dark" });

    // 5. App should react without reload and apply dark mode
    await expect(html).toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-theme", "dark");

    // 6. Emulate system preference -> Light
    await page.emulateMedia({ colorScheme: "light" });

    // 7. App should instantly remove dark mode
    await expect(html).not.toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-theme", "light");
  });
});
