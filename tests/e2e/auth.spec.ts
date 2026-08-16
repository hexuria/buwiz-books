import { expect, test } from "@playwright/test";

// Clear the storage state so we test from a logged-out perspective
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Authentication", () => {
  test("login page renders the current sign-in controls", async ({ page }) => {
    await page.goto("/login");

    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /send sign-in code/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  });

  test("sending a dev OTP shows the six-digit verification UI", async ({ page }) => {
    await page.goto("/login");

    // Fill only once hydration has replayed React's initial state — see the
    // same guard in auth.setup.ts. Typing earlier is silently discarded and
    // the submit button never enables.
    const emailInput = page.getByLabel(/email address/i);
    const sendCodeButton = page.getByRole("button", { name: /send sign-in code/i });
    await expect(async () => {
      await emailInput.fill("hugoforbes88@gmail.com");
      await expect(sendCodeButton).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await sendCodeButton.click();

    await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();
    await expect(page.getByLabel(/one-time password digit 1/i)).toBeVisible();
    await expect(page.getByLabel(/one-time password digit 6/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /verify & sign in/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /resend code/i })).toBeVisible();
  });
});
