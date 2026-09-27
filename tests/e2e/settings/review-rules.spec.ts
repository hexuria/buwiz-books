import { test, expect } from "@playwright/test";

/**
 * Review rule configuration lives in Settings. Inbox book findings read these rows live per
 * organization, so the section has to show the seeded catalog and edit it through labelled
 * controls.
 *
 * Deliberately never saves. The suite is fullyParallel across three browsers on one database: a
 * saved rule change would race the other browsers' copies of this spec (the optimistic version
 * check rejects the loser) and retune checks underneath the Inbox specs. What a save sends is
 * pinned by tests/component/ReviewRulesSettings.test.tsx.
 */
test.describe("Settings Review Rules", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "Review Rules" }).click();
  });

  test("lists the seeded catalog by group", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Review Rules", level: 2 })).toBeVisible();
    for (const group of ["Inbox checks", "Ledger checks", "System checks"]) {
      await expect(page.getByRole("region", { name: group })).toBeVisible();
    }
    // An empty section here means db:seed:review-rules did not run.
    await expect(page.getByText("No review agents are set up yet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit Uncategorized" })).toBeVisible();
  });

  test("edits a ledger check through labelled controls, never a JSON textarea", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Edit Unusual Spend" }).click();

    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Enable Unusual Spend" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Approval impact" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Stop" })).toBeAttached();
    await expect(page.getByRole("radio", { name: "Warn" })).toBeAttached();
    await expect(page.getByRole("spinbutton", { name: "Standard deviations" })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Lookback window" })).toBeVisible();
  });

  test("tells an Inbox check apart from a ledger check", async ({ page }) => {
    await page.getByRole("button", { name: "Edit Uncategorized" }).click();
    await expect(
      page.getByText(/Runs automatically on every transaction that enters the Inbox/i),
    ).toBeVisible();
    // A lookback window is meaningless for a rule evaluated once at ingest.
    await expect(page.getByText(/there is no lookback window/i)).toBeVisible();
  });

  test("holds the ledger scan and its findings next to the ledger checks", async ({ page }) => {
    const scan = page.getByRole("region", { name: "Scan books" });
    await expect(scan.getByRole("button", { name: "Scan books", exact: true })).toBeEnabled();
    await expect(scan.getByText("Ledger findings", { exact: true })).toBeVisible();
    await expect(scan.getByRole("button", { name: /Unusual Spend/ })).toBeVisible();
    await expect(scan.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await expect(scan.getByRole("button", { name: "All", exact: true })).toBeVisible();
  });

  test("offers Save only for a real change, and Discard puts it back", async ({ page }) => {
    await page.getByRole("button", { name: "Edit Missing Receipt" }).click();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();

    const threshold = page.getByRole("spinbutton", { name: "Receipt required above" });
    const original = await threshold.inputValue();
    await threshold.fill(String(Number(original) + 1));
    await expect(save).toBeEnabled();

    await page.getByRole("button", { name: "Discard" }).click();
    await expect(threshold).toHaveValue(original);
    await expect(save).toBeDisabled();
  });
});

test.describe("Settings Review Rules deep link", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test("opens straight onto the linked rule, as the Inbox's Rule settings link does", async ({
    page,
  }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    const href = await settingsLink.getAttribute("href");
    await page.goto(`${href}?section=review-rules&rule=missing_receipt`);

    await expect(page.getByRole("heading", { name: "Review Rules", level: 2 })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable Missing Receipt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Missing Receipt" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
