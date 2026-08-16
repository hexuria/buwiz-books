/**
 * Nitro server route: POST /api/dev/login  — DEV-ONLY passwordless login bypass.
 *
 * Lets you sign in as a designated test account with one click, skipping the 6-digit email
 * OTP and Google login. It does NOT forge a session — it drives the REAL better-auth email-OTP
 * flow server-side (generate the code → read it from the DB → verify it), so the resulting
 * session/cookie is identical to a normal login.
 *
 * ── Hard-gated OFF unless BOTH are true (defense in depth): ──────────────────
 *   process.env.NODE_ENV !== "production"
 *   process.env.DEV_LOGIN_BYPASS === "true"
 * Otherwise the route responds 404 as if it does not exist.
 *
 * Setup (add to .env for local dev):
 *   DEV_LOGIN_BYPASS=true
 *   DEV_LOGIN_EMAIL=ceo@goldcoders.dev        # the seeded test account to log in as
 *   # optional allowlist if you want to switch accounts from the client:
 *   DEV_LOGIN_EMAILS=ceo@goldcoders.dev,owner@test.local
 */
import { defineEventHandler, readBody, createError } from "h3";
import { eq, desc } from "drizzle-orm";
import { auth } from "../../../../src/lib/auth";
import { db } from "../../../../src/db";
import { verification } from "../../../../src/db/schema/auth";
import { createLogger } from "../../../../src/lib/logger";

const logger = createLogger("api.dev.login");

function bypassEnabled(): boolean {
  return (
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") &&
    process.env.DEV_LOGIN_BYPASS === "true"
  );
}

function allowedEmails(): string[] {
  const list = (process.env.DEV_LOGIN_EMAILS ?? process.env.DEV_LOGIN_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list;
}

export default defineEventHandler(async (event) => {
  // Route does not exist unless explicitly enabled in a non-production env.
  if (!bypassEnabled()) {
    throw createError({ statusCode: 404, message: "Not found" });
  }

  const body = (await readBody(event).catch(() => ({}))) as { email?: string } | undefined;
  const allow = allowedEmails();
  const requested = (body?.email ?? process.env.DEV_LOGIN_EMAIL ?? "").trim().toLowerCase();

  if (!requested) {
    throw createError({ statusCode: 400, message: "DEV_LOGIN_EMAIL is not configured." });
  }
  if (!allow.includes(requested)) {
    throw createError({
      statusCode: 403,
      message: `Email not in dev-login allowlist. Add it to DEV_LOGIN_EMAILS.`,
    });
  }

  const base = process.env.BETTER_AUTH_URL || "http://localhost:3000";

  // 1. Generate a sign-in OTP through the real better-auth endpoint (email send is a no-op
  //    for test emails / when no Resend key is set — the code is still written to the DB).
  const sendRes = await auth.handler(
    new Request(`${base}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: requested, type: "sign-in" }),
    }),
  );
  if (!sendRes.ok) {
    const text = await sendRes.text();
    logger.error("dev-login: failed to generate OTP", { email: requested, text });
    // Surface better-auth's own reason. The generic message this used to return
    // hid the overwhelmingly common cause — INVITE_ONLY=true plus an email that
    // is not a user yet, which better-auth rejects — and sent you reading the
    // OTP plumbing instead of the account. Safe to expose: this route is already
    // hard-gated to non-production with DEV_LOGIN_BYPASS=true.
    let reason = text;
    try {
      reason = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* not JSON — fall back to the raw body */
    }
    const hint =
      process.env.INVITE_ONLY === "true"
        ? ` INVITE_ONLY is on, so "${requested}" must already exist as a user — run \`bun db:seed\` (it provisions every DEV_LOGIN_EMAILS entry) or invite the address.`
        : "";
    throw createError({
      statusCode: 500,
      message: `Failed to generate sign-in code for "${requested}": ${reason}.${hint}`,
    });
  }

  // 2. Read the freshly-generated OTP from auth_verifications (stored as "<otp>:<attempts>").
  let otp = "";
  for (let i = 0; i < 6 && !otp; i++) {
    const [row] = await db
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, `sign-in-otp-${requested}`))
      .orderBy(desc(verification.createdAt))
      .limit(1);
    if (row?.value) otp = row.value.split(":")[0];
    if (!otp) await new Promise((r) => setTimeout(r, 150));
  }
  if (!otp) {
    throw createError({ statusCode: 500, message: "Could not retrieve the generated code." });
  }

  // 3. Sign in through the real endpoint so the session + Set-Cookie are produced normally,
  //    then return that response verbatim (cookies flow straight back to the browser).
  const signInRes = await auth.handler(
    new Request(`${base}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: requested, otp }),
    }),
  );

  logger.info("dev-login used", { email: requested, ok: signInRes.ok });
  return signInRes;
});
