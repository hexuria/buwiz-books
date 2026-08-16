import { chromium } from "playwright";
import { db } from "../src/db/index";
import { verification } from "../src/db/schema/auth";
import { eq, desc } from "drizzle-orm";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("Navigating to login page...");
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });

  // Submit email
  await page.fill('input[type="email"]', "hugoforbes88@gmail.com");
  await page.click('button:has-text("Send sign-in code")');
  console.log("Requested OTP...");

  // Wait 1.5 seconds for backend to generate OTP and save to DB
  await page.waitForTimeout(1500);

  // Retrieve OTP from database
  const verifications = await db
    .select()
    .from(verification)
    .where(eq(verification.identifier, "sign-in-otp-hugoforbes88@gmail.com"))
    .orderBy(desc(verification.createdAt))
    .limit(1);

  if (verifications.length === 0) {
    console.error("❌ No OTP found in database.");
    process.exit(1);
  }

  const otp = verifications[0].value.split(":")[0];
  console.log("Retrieved OTP from DB:", otp);

  // Fill OTP
  // The OTP inputs are 6 separate inputs with class 'login-otp-input'
  const inputs = await page.$$(".login-otp-input");
  for (let i = 0; i < 6; i++) {
    await inputs[i].fill(otp[i]);
  }

  // The UI auto-submits once the 6th digit is filled. Wait for the redirect.

  // Wait for redirect to dashboard
  await page.waitForURL("http://localhost:3000/", { timeout: 10000 });
  console.log("✅ Successfully logged in! Context is authenticated.");

  // Save state to reuse? We don't need to, we can just use the same page!

  const configs = [
    {
      url: "http://localhost:3000/financials?tab=profit-loss&dateFrom=2026-01-01&dateTo=2026-03-31&compare=none&agingType=ap",
      path: "docs/images/financials/profit-loss.png",
      name: "Profit & Loss",
    },
    {
      url: "http://localhost:3000/financials?tab=balance-sheet&dateFrom=2026-01-01&dateTo=2026-03-31&compare=none&agingType=ap",
      path: "docs/images/financials/balance-sheet.png",
      name: "Balance Sheet",
    },
    {
      url: "http://localhost:3000/financials?tab=cash-flow&dateFrom=2026-01-01&dateTo=2026-03-31&compare=none&agingType=ap",
      path: "docs/images/financials/cash-flow.png",
      name: "Cash Flow",
    },
    {
      url: "http://localhost:3000/financials?tab=trial-balance&dateFrom=2026-01-01&dateTo=2026-03-31&compare=none&agingType=ap",
      path: "docs/images/financials/trial-balance.png",
      name: "Trial Balance",
    },
    {
      url: "http://localhost:3000/financials?tab=aging&dateFrom=2026-01-01&dateTo=2026-03-31&compare=none&agingType=ar",
      path: "docs/images/financials/aging-ar.png",
      name: "Aging AR",
    },
  ];

  for (const config of configs) {
    try {
      console.log(`Navigating to ${config.name}...`);
      await page.goto(config.url, { waitUntil: "networkidle" });

      // Force Light Mode via DOM and LocalStorage
      await page.evaluate(() => {
        document.documentElement.classList.remove("dark");
        document.documentElement.setAttribute("data-theme", "light");
        localStorage.setItem("buwiz-theme", "light");
      });

      // Allow a generous moment for TanStack Query and SSR hydration to complete correctly
      await page.waitForTimeout(3000);

      // Verify page state isn't a crash or login page
      const content = await page.content();
      if (content.includes("Sign In") || content.includes("Login") || content.includes("Sign in")) {
        console.log(`[WARNING] Hit sign-in page on ${config.name}. Authentication was rejected.`);
      }

      await page.screenshot({
        path: config.path,
        fullPage: true,
      });
      console.log(`✅ Captured ${config.name} -> ${config.path}`);
    } catch (e) {
      console.error(`❌ Failed to capture ${config.name}:`, e);
    }
  }

  await browser.close();
}

main();
