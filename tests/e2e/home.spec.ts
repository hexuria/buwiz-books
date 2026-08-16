import { expect, test } from "@playwright/test";

test.describe("Root Routing", () => {
  // Explicitly use an empty storage state to test the unauthenticated flow
  test.use({ storageState: { cookies: [], origins: [] } });

  test("cold unauthenticated visits redirect before protected UI renders", async ({ page }) => {
    const hydrationErrors: string[] = [];
    const protectedRenderMarkers: string[] = [];
    const rootDocumentStatuses: number[] = [];

    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Hydration failed")) {
        hydrationErrors.push(message.text());
      }
      if (message.text() === "__DIGITS_PROTECTED_UI_RENDERED__") {
        protectedRenderMarkers.push(message.text());
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/" && response.request().resourceType() === "document") {
        rootDocumentStatuses.push(response.status());
      }
    });

    await page.addInitScript(() => {
      const markProtectedContent = () => {
        if (document.body?.textContent?.includes("Your business at a glance")) {
          console.debug("__DIGITS_PROTECTED_UI_RENDERED__");
        }
      };

      document.addEventListener("DOMContentLoaded", () => {
        markProtectedContent();
        new MutationObserver(markProtectedContent).observe(document.body, {
          childList: true,
          subtree: true,
        });
      });
    });

    await page.goto("/");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    expect(rootDocumentStatuses).toContain(307);
    expect(protectedRenderMarkers).toEqual([]);
    expect(hydrationErrors).toEqual([]);
  });
});
