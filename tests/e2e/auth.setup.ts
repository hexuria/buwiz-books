import { test as setup, expect } from "@playwright/test";
import postgres from "postgres";

const authFile = "tests/e2e/.auth/user.json";
const TEST_EMAIL = "hugoforbes88@gmail.com";

setup("authenticate", async ({ page }) => {
  const transitionViolations: string[] = [];
  page.on("console", (message) => {
    const marker = "__DIGITS_AUTH_TRANSITION_VIOLATION__:";
    if (message.text().startsWith(marker)) {
      transitionViolations.push(message.text().slice(marker.length));
    }
  });

  await page.addInitScript(() => {
    const reported = new Set<string>();
    let transitionStarted = false;

    const report = (violation: string) => {
      if (reported.has(violation)) return;
      reported.add(violation);
      console.error(`__DIGITS_AUTH_TRANSITION_VIOLATION__:${violation}`);
    };

    const inspect = () => {
      const loginForm = document.querySelector("#login-email");
      const sidebar = Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Sign Out",
      );

      if (loginForm && sidebar) report("authenticated shell rendered around login form");
      if (transitionStarted && loginForm) report("login form returned after OTP verification");
    };

    Object.defineProperty(window, "__startDigitsAuthTransition", {
      value: () => {
        transitionStarted = true;
        inspect();
      },
    });

    document.addEventListener("DOMContentLoaded", () => {
      inspect();
      new MutationObserver(inspect).observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  });

  // 1. Go to login
  await page.goto("/login");

  // Fill only once the app has hydrated. The login page is server-rendered, so
  // a value typed before hydration is wiped when React replays its initial
  // state — the field goes empty, the submit button stays disabled, and the
  // click times out. Retrying the fill until the button enables is the signal
  // that hydration has actually happened.
  const emailInput = page.getByLabel(/email address/i);
  const sendCodeButton = page.getByRole("button", { name: /send sign-in code/i });
  await expect(async () => {
    await emailInput.fill(TEST_EMAIL);
    await expect(sendCodeButton).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await sendCodeButton.click();

  // 2. Wait for OTP step to appear
  await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();

  // 3. Fetch OTP from database
  // Connection string from env or assume default dev DB
  const dbUrl = process.env.DATABASE_URL || "postgresql://uriah@localhost:5432/buwiz-books";
  const sql = postgres(dbUrl);

  // We need to poll briefly because the insert might take a few ms
  let otp = "";
  // Wait up to 5 seconds for OTP to appear in DB
  for (let i = 0; i < 10; i++) {
    const [row] = await sql`
      SELECT value FROM auth_verifications
      WHERE identifier LIKE ${"%" + TEST_EMAIL + "%"}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (row && row.value) {
      otp = row.value.split(":")[0]; // value is format "123456:0"
      break;
    }
    await page.waitForTimeout(500);
  }

  await sql.end();

  if (!otp) {
    throw new Error("Failed to retrieve OTP from database");
  }

  // 4. Fill OTP digits and auto-verify
  await page.evaluate(() => {
    (
      window as typeof window & {
        __startDigitsAuthTransition: () => void;
      }
    ).__startDigitsAuthTransition();
  });
  for (let i = 0; i < 6; i++) {
    await page.getByLabel(`One-time password digit ${i + 1}`).fill(otp[i]);
  }

  // 5. Wait for redirect to dashboard
  await page.waitForURL("/", { timeout: 15000 });
  await expect(page.getByText(/your business at a glance/i)).toBeVisible();
  expect(transitionViolations).toEqual([]);

  // 6. Save authenticated state
  await page.context().storageState({ path: authFile });
});
