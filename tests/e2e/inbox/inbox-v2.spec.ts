import { test, expect, type Page } from "@playwright/test";

/**
 * The Inbox (research spec §10). Since the cutover it is the only Inbox: no per-organization
 * switch, no classic page.
 *
 * Run it against the offline AI runtime so nothing the pages render can reach a model:
 *
 *     AI_MODE=mock bun run test:e2e tests/e2e/inbox/inbox-v2.spec.ts
 *
 * (Playwright hands its environment to the `dev:test` server it starts.) The entries here are
 * typed by hand, so no step depends on model output.
 */

test.skip(process.env.AI_MODE !== "mock", "Inbox v2 E2E runs with AI_MODE=mock");
test.describe.configure({ mode: "serial" });
test.use({ storageState: "tests/e2e/.auth/user.json" });

async function pickOption(page: Page, trigger: string, search: string, option: RegExp) {
  await page.getByText(trigger, { exact: true }).locator("visible=true").first().click();
  await page.locator("input[role=combobox]").locator("visible=true").first().fill(search);
  await page.getByRole("option", { name: option }).first().click();
}

/** Submit a paid expense through New transaction; returns the Inbox item id it lands on. */
async function submitExpense(page: Page, input: { memo: string; amount: string; vendor?: string }) {
  await page.goto("/transactions/new?type=pay_out");
  await expect(page.getByText("Select Party", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("Add a memo...").fill(input.memo);
  await pickOption(page, "Account...", "Mercury", /Mercury Credit Card/);
  await pickOption(page, "Category", "Office Supplies", /Office Supplies/);
  await page.getByPlaceholder("$0.00").locator("visible=true").first().fill(input.amount);
  if (input.vendor) await pickOption(page, "Select Party", input.vendor, new RegExp(input.vendor));
  await page.getByRole("button", { name: "Save & Close" }).click();
  await page.waitForURL(/\/inbox\?selected=/, { timeout: 15_000 });
  const id = new URL(page.url()).searchParams.get("selected");
  expect(id).toBeTruthy();
  return id!;
}

function row(page: Page, id: string) {
  return page.locator(`[data-item-id="${id}"]`);
}

test.describe("Inbox", () => {
  test("/inbox is the triage screen, with no classic page and no switch", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page.getByRole("toolbar", { name: "Filter by reason" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Review queue")).toHaveCount(0);
    // An old classic-Inbox link with a state filter lands on the same screen.
    await page.goto("/inbox?state=approved");
    await expect(page.getByRole("toolbar", { name: "Filter by reason" })).toBeVisible();
    for (const chip of [
      "All",
      "Needs a fix",
      "Jev unsure",
      "Spot check",
      "Failed",
      "Ready to approve",
    ]) {
      await expect(
        page.getByRole("toolbar", { name: "Filter by reason" }).getByRole("button", {
          name: new RegExp(`^${chip}`),
        }),
      ).toBeVisible();
    }
  });

  test("an entry lands with a reason, is fixed through its checks, and approves with 'a'", async ({
    page,
  }) => {
    const memo = `E2E inbox v2 approve ${Date.now()}`;
    const id = await submitExpense(page, { memo, amount: "9.37", vendor: "Amazon Web Services" });

    // Opened on the item it just submitted, in its editor, with one reason chip.
    await expect(row(page, id)).toHaveAttribute("aria-current", "true");
    await expect(page.getByPlaceholder("Add a memo...").locator("visible=true")).toHaveValue(memo);
    await expect(row(page, id).locator("[data-reason]")).toHaveCount(1);

    // Resolve whatever checks block it (department, location, …) with a documented exception,
    // the documented-exception action. Approve stays off until none block.
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    const notes = page.getByPlaceholder("Resolution or documented exception");
    for (
      let remaining = await notes.count();
      remaining > 0 && (await approve.isDisabled());
      remaining = await notes.count()
    ) {
      await notes.first().fill("E2E documented exception");
      await page.getByRole("button", { name: "Resolve" }).first().click();
      await expect(notes).toHaveCount(remaining - 1);
    }
    const override = page.getByPlaceholder("Required to approve your own submission");
    if (await override.isVisible()) await override.fill("E2E owner approval");
    await expect(approve).toBeEnabled();

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("a");
    await expect(row(page, id)).toHaveCount(0);
    await expect(page.getByText(/^Approved( as .+)?\.$/)).toBeVisible();

    // No Done folder: an approved item never comes back.
    await page.reload();
    await expect(page.getByRole("toolbar", { name: "Filter by reason" })).toBeVisible();
    await expect(row(page, id)).toHaveCount(0);
  });

  test("r rejects with a reason and the item leaves the Inbox", async ({ page }) => {
    const id = await submitExpense(page, {
      memo: `E2E inbox v2 reject ${Date.now()}`,
      amount: "4.21",
    });
    await expect(row(page, id)).toHaveAttribute("aria-current", "true");

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("r");
    const why = page.getByLabel("Why reject it?");
    await expect(why).toBeFocused();
    await why.fill("E2E: not a business expense");
    await why.press("Enter");

    await expect(row(page, id)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("toolbar", { name: "Filter by reason" })).toBeVisible();
    await expect(row(page, id)).toHaveCount(0);
  });

  test("j and k move through the list", async ({ page }) => {
    await submitExpense(page, { memo: `E2E inbox v2 first ${Date.now()}`, amount: "3.11" });
    await submitExpense(page, { memo: `E2E inbox v2 second ${Date.now()}`, amount: "3.12" });
    await page.goto("/inbox");
    const rows = page.getByRole("list", { name: "Items that need you" }).getByRole("button");
    await expect(rows.first()).toHaveAttribute("aria-current", "true");

    await page.keyboard.press("j");
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("k");
    await expect(rows.first()).toHaveAttribute("aria-current", "true");
  });

  test("below lg the reading pane is a full-height drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/inbox");
    const rows = page.getByRole("list", { name: "Items that need you" }).getByRole("button");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await rows.first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Back to Inbox" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
