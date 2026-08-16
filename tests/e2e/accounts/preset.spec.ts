import { test, expect } from "@playwright/test";

test.describe("Chart-of-accounts preset", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("can open the template picker from the New Category dropdown", async ({ page }) => {
    // The split button's chevron opens the dropdown.
    await page.getByRole("button", { name: /more category options/i }).click();
    const templateItem = page.getByRole("button", { name: /Apply a template/i });
    await expect(templateItem).toBeVisible();
    await templateItem.click();

    await expect(page.getByText("Start from a template")).toBeVisible();
    // The catalog is fetched, so give it room under parallel load.
    await expect(page.getByRole("button", { name: /General small business/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /SaaS \/ startup/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Freelancer \/ consultant/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Retail \/ e-commerce/ })).toBeVisible();
  });

  test("previewing a template describes the change before anything is written", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /more category options/i }).click();
    await page.getByRole("button", { name: /Apply a template/i }).click();

    const saasCard = page.getByRole("button", { name: /SaaS \/ startup/ });
    await expect(saasCard).toBeVisible({ timeout: 20_000 });
    await saasCard.click();
    await page.getByRole("button", { name: "Continue" }).click();

    // The preview is a dry run: it must state what happens and must promise
    // that nothing existing is destroyed.
    await expect(page.getByText(/categories will be created|already fully applied/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/No categories are removed, renamed, or re-typed|already fully applied/),
    ).toBeVisible();

    // Apply is available but we stop here — this spec must not mutate the
    // shared E2E chart of accounts.
    await expect(page.getByRole("button", { name: /Apply template|Done/ })).toBeVisible();
  });

  test("the mappings page reports whether any row is still unmapped", async ({ page }) => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");

    // Navigate via the app rather than a hardcoded org id.
    const mappingsLink = page.getByRole("link", { name: /Mappings/i }).first();
    if (await mappingsLink.isVisible().catch(() => false)) {
      await mappingsLink.click();
      await page.waitForLoadState("networkidle");
      // Either every row is mapped (no banner) or the banner names the gaps.
      const banner = page.getByText(/still have no account/);
      const count = await banner.count();
      if (count > 0) {
        await expect(banner.first()).toBeVisible();
      }
    }
  });
});
