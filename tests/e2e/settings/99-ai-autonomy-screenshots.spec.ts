import { test, expect } from "@playwright/test";

const SHOT_DIR = process.env.SCREENSHOT_DIR ?? "test-results/screenshots";

/**
 * Program 2 P10 — responsive verification of the earned-autonomy Automation
 * block in organization settings (AI Providers & Guardrails section).
 * Captures phone / tablet / desktop and asserts the page body never scrolls
 * horizontally (the CLAUDE-plan's responsiveness gate).
 */
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.describe("AI autonomy settings responsive screenshots", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  for (const viewport of VIEWPORTS) {
    test(`renders without horizontal overflow at ${viewport.name}`, async ({ page }) => {
      // The settings URL is org-scoped. Discover it from the sidebar link at
      // desktop width (always in the DOM there), THEN resize to the target
      // viewport — mobile renders the sidebar inside a closed drawer.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      const settingsLink = page.locator('a[href*="/organization/"][href$="/settings"]').first();
      await expect(settingsLink).toBeAttached({ timeout: 30_000 });
      const href = await settingsLink.getAttribute("href");
      if (!href) throw new Error("Org settings link missing from sidebar");

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(href);

      // Settings is a tabbed page — the governance section (and this PR's
      // Automation block) lives under the AI Credentials tab.
      const aiTab = page.getByRole("button", { name: /AI Credentials/i });
      await expect(aiTab).toBeVisible({ timeout: 30_000 });
      await aiTab.click();

      // The Automation block ships in this PR — its copy and both flippable
      // kind rows must render at every width, with the walled-kinds footnote.
      await expect(page.getByText("AI Providers & Guardrails")).toBeVisible({ timeout: 30_000 });
      const automation = page.getByText("Automation", { exact: true });
      await automation.scrollIntoViewIfNeeded();
      await expect(automation).toBeVisible();
      await expect(page.getByText("Document type labels")).toBeVisible();
      await expect(page.getByText("Category mapping defaults")).toBeVisible();
      await expect(page.getByText(/Always applied by a human/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Toggle auto-apply for Document type labels/i }),
      ).toBeAttached();

      await page.screenshot({
        path: `${SHOT_DIR}/p10-ai-autonomy-${viewport.name}.png`,
        fullPage: true,
      });

      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return el.scrollWidth - el.clientWidth;
      });
      expect(
        overflow,
        `${viewport.name}: body scrolls horizontally by ${overflow}px`,
      ).toBeLessThanOrEqual(1);
    });
  }
});
