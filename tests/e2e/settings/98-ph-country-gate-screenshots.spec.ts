import { test, expect } from "@playwright/test";
import postgres from "postgres";

const SHOT_DIR = process.env.SCREENSHOT_DIR ?? "test-results/screenshots";
const RECON_ID = "5b6077b6-3ae3-437d-95ab-7281455d8494";

/**
 * Program 2 P12 — the D6 PH country gate, visually verified in all three
 * module states at phone / tablet / desktop. States are staged directly in
 * the test database (country + one payroll run) and fully restored after.
 */
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.describe.configure({ mode: "serial" });

let sql: postgres.Sql;
let ORG: string;
let stagedRunId: string | null = null;

test.beforeAll(async () => {
  sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
  const [row] = await sql`SELECT organization_id FROM reconciliations WHERE id = ${RECON_ID}`;
  ORG = row.organization_id;
});

test.afterAll(async () => {
  if (stagedRunId) await sql`DELETE FROM payroll_runs WHERE id = ${stagedRunId}`;
  await sql`UPDATE organization_accounting_settings SET country = NULL WHERE organization_id = ${ORG}`;
  await sql.end();
});

async function setCountry(country: string | null) {
  await sql`
    INSERT INTO organization_accounting_settings (organization_id, country)
    VALUES (${ORG}, ${country})
    ON CONFLICT (organization_id) DO UPDATE SET country = ${country}, updated_at = now()
  `;
}

async function assertNoOverflow(page: import("@playwright/test").Page, label: string) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${label}: body scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
}

test.describe("PH country gate screenshots", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  for (const viewport of VIEWPORTS) {
    test(`OFF state at ${viewport.name}: tax page shows the enable prompt`, async ({ page }) => {
      await setCountry(null);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/tax/settings");
      await expect(
        page.getByRole("heading", { name: /Philippine tax & payroll is not enabled/i }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("link", { name: /Set organization country/i })).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/p12-off-${viewport.name}.png`, fullPage: true });
      await assertNoOverflow(page, `off-${viewport.name}`);
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`ACTIVE state at ${viewport.name}: country select + live tax page`, async ({ page }) => {
      await setCountry("PH");
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await page.goto(`/organization/${ORG}/settings`);
      const select = page.locator("#org-country");
      await expect(select).toBeVisible({ timeout: 30_000 });
      await select.scrollIntoViewIfNeeded();
      await expect(select).toHaveValue("PH");
      await page.screenshot({
        path: `${SHOT_DIR}/p12-country-select-${viewport.name}.png`,
        fullPage: true,
      });
      await assertNoOverflow(page, `country-select-${viewport.name}`);

      await page.goto("/tax/settings");
      await expect(
        page.getByRole("heading", { name: /Philippine tax & payroll is not enabled/i }),
      ).toBeHidden();
      await page.screenshot({
        path: `${SHOT_DIR}/p12-active-${viewport.name}.png`,
        fullPage: true,
      });
      await assertNoOverflow(page, `active-${viewport.name}`);
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`ARCHIVED state at ${viewport.name}: read-only banner`, async ({ page }) => {
      if (!stagedRunId) {
        const [run] = await sql`
          INSERT INTO payroll_runs (organization_id, taxable_year, payroll_period, period_start, period_end, period_index)
          VALUES (${ORG}, 2026, 'monthly', '2026-07-01', '2026-07-31', 7)
          RETURNING id
        `;
        stagedRunId = run.id;
      }
      await setCountry("US");
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/payroll");
      await expect(page.getByText(/Archived\./)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/read-only/i).first()).toBeVisible();
      await page.screenshot({
        path: `${SHOT_DIR}/p12-archived-${viewport.name}.png`,
        fullPage: true,
      });
      await assertNoOverflow(page, `archived-${viewport.name}`);
    });
  }
});
