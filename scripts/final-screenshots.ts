import { chromium } from "playwright";
import { db } from "../src/db/index";
import { session, user } from "../src/db/schema/auth";
import { eq } from "drizzle-orm";

async function main() {
  const browser = await chromium.launch();

  // Get active session
  const users = await db.select().from(user).where(eq(user.email, "hugoforbes88@gmail.com"));
  const sess = await db.select().from(session).where(eq(session.userId, users[0].id));
  const token = sess.length > 0 ? sess[0].token : null;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 1. Capture Login Page
  const loginPage = await context.newPage();
  await loginPage.goto("http://localhost:3000/login");
  await loginPage.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("buwiz-theme", "light");
  });
  await loginPage.waitForTimeout(500);
  await loginPage.screenshot({ path: "docs/images/login.png", fullPage: true });
  console.log("Captured login.png");

  // Inject session using 'url' instead of 'domain' to guarantee match
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: token!,
      url: "http://localhost:3000/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();

  // 2. Importing Transactions
  try {
    await page.goto("http://localhost:3000/transactions", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("buwiz-theme", "light");
    });
    await page.waitForTimeout(1000);
    // Add Transaction split button
    const addSpan = page.getByText("Add Transaction");
    const chevronBtn = addSpan.locator("xpath=../..").locator("button").nth(1);
    await chevronBtn.click({ force: true });
    await page.waitForTimeout(500);
    await page.getByText("Import Bank Transactions…").click({ force: true });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: "docs/images/ledger/importing-transactions.png",
      fullPage: true,
    });
    console.log("Captured importing-transactions.png");
  } catch (e) {
    console.log("Failed import", e);
  }

  // 3. AI Bill Scanning
  try {
    await page.goto("http://localhost:3000/bills", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page.waitForTimeout(1000);
    // Find Upload/Scan button
    const uploadBtn = await page.$$('button:has-text("Upload"), button:has-text("Scan")');
    if (uploadBtn.length > 0) {
      await uploadBtn[0].click({ force: true });
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: "docs/images/bills/ai-bill-scanning.png", fullPage: true });
    console.log("Captured ai-bill-scanning.png");
  } catch (e) {
    console.log("Failed bill scan", e);
  }

  // 4. Matching Process
  try {
    await page.goto("http://localhost:3000/reconciliations", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page.waitForTimeout(1000);
    const links = await page.$$('a[href^="/reconciliations/"]');
    if (links.length > 0) {
      await links[0].click({ force: true });
      await page.waitForTimeout(2000);
    }
    await page.screenshot({
      path: "docs/images/reconciliations/matching-process.png",
      fullPage: true,
    });
    console.log("Captured matching-process.png");
  } catch (e) {
    console.log("Failed match process", e);
  }

  await browser.close();
}

main();
