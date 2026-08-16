import { test, expect } from "@playwright/test";

/**
 * These cover the things that were wrong on the live page: it explained nothing, its state lived
 * in React rather than the URL, and its one configuration control was a raw JSON textarea.
 *
 * The catalog is present because `db:test:fresh` now runs `db:seed:review-rules` — which is the
 * whole point of the seeding work. An empty page here means the seed did not run.
 */
test.describe("Review agents", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/review-agents");
    await page.waitForLoadState("networkidle");
  });

  test("explains the book/review split without being asked", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Review agents", level: 1 })).toBeVisible();
    await expect(page.getByText("Book agents run automatically")).toBeVisible();
    await expect(page.getByText("Review agents run when you ask")).toBeVisible();
    // The old "Run all agents" label was a lie once the run was scoped to 5 of 16 agents.
    await expect(page.getByRole("button", { name: /Run review agents/i })).toBeVisible();
  });

  test("shows the seeded catalog rather than an empty shell", async ({ page }) => {
    await expect(page.getByRole("button", { name: /Uncategorized/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unusual Spend/i })).toBeVisible();
    await expect(page.getByText("No review agents are set up yet")).toHaveCount(0);
  });

  test("puts the selected agent in the URL and keeps it across a reload", async ({ page }) => {
    await page.getByRole("button", { name: /Missing Receipt/i }).click();
    await expect(page).toHaveURL(/[?&]agent=missing_receipt/);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Missing Receipt", level: 2 })).toBeVisible();
  });

  test("deep-links straight to an agent", async ({ page }) => {
    await page.goto("/review-agents?agent=unusual_spend");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Unusual Spend", level: 2 })).toBeVisible();
    await expect(page.getByText(/Runs when you press Run review agents/i)).toBeVisible();
  });

  test("configures through labelled fields, never a raw JSON textarea", async ({ page }) => {
    await page.goto("/review-agents?agent=unusual_spend");
    await page.waitForLoadState("networkidle");

    // The old editor was a single unlabelled JSON blob; every knob is now a named control.
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: /Standard deviations/i })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: /Lookback window/i })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /Approval impact/i })).toBeVisible();
  });

  test("tells a book agent apart from a review agent in the detail pane", async ({ page }) => {
    await page.goto("/review-agents?agent=uncategorized");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByText(/Runs automatically on every transaction that enters the Inbox/i),
    ).toBeVisible();
    // A lookback window is meaningless for a rule evaluated once at ingest.
    await expect(page.getByText(/there is no lookback window/i)).toBeVisible();
  });

  test("surfaces a findings section instead of a bare count", async ({ page }) => {
    await page.goto("/review-agents?agent=unusual_spend");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  });
});

test.describe("Review agents navigation", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test("is reachable from the sidebar next to Inbox", async ({ page }) => {
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "Review Agents" }).click();
    await expect(page).toHaveURL(/\/review-agents/);
  });
});
