import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, emailOTP } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { serverBrand } from "@/config/brand";
import { ac, roles } from "./permissions";
import * as authSchema from "@/db/schema/auth";
import { createLogger } from "./logger";
import { getTrustedOrigins } from "./request-guards";

const resend = new Resend(process.env.RESEND_API_KEY);
const logger = createLogger("auth");

/**
 * Invite-only gate
 *
 * When INVITE_ONLY=true, only users whose email already exists in auth_users
 * (pre-created via org invitation) can sign in. New / unknown emails are blocked.
 *
 * ADMIN_EMAIL always bypasses the gate for initial bootstrap.
 * Default (INVITE_ONLY unset or "false"): public registration — anyone can sign in.
 */
const isInviteOnly = process.env.INVITE_ONLY === "true";
const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();

/**
 * Check whether an email already has an account in auth_users.
 * Returns true if the user exists (and is therefore allowed to sign in).
 */
async function userExistsByEmail(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email.toLowerCase()))
    .limit(1);
  return rows.length > 0;
}

/**
 * Returns true when the given email should bypass the invite-only gate.
 * The ADMIN_EMAIL env var is always allowed through — this is how the
 * very first admin bootstraps the system.
 */
function isEmailAllowed(email: string): boolean {
  if (!isInviteOnly) return true;
  if (adminEmail && email.toLowerCase() === adminEmail) return true;
  return false;
}

/**
 * Better Auth Server Instance
 *
 * Configured with:
 * - Drizzle ORM adapter for PostgreSQL
 * - Google OAuth provider
 * - Organization plugin for multi-tenant RBAC
 * - Invite-only registration enforcement (INVITE_ONLY env var)
 */
export const auth = betterAuth({
  // Canonical base URL — prevents Cloud Run's internal hostname from leaking
  // into OAuth redirect_uri and post-login callbacks when behind a reverse proxy
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),

  // Email/password disabled — using Email OTP plugin instead
  emailAndPassword: {
    enabled: false,
  },

  // Google OAuth provider
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      // When invite-only, prevent Google OAuth from auto-creating new users.
      // Existing users who linked Google can still sign in.
      ...(isInviteOnly ? { disableImplicitSignUp: true } : {}),
    },
  },

  // Account linking — allows users to connect multiple auth methods
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },

  // Session configuration
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60 * 24, // 24 hours — list endpoints no longer refresh session
    },
  },

  // ── Invite-only hooks ─────────────────────────────────────────────────
  // Intercept sign-in flows to block unknown emails when INVITE_ONLY=true.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!isInviteOnly) return;

      // Gate 1: Block OTP send for unknown emails — best UX: fails before code is sent
      if (ctx.path === "/email-otp/send-verification-otp") {
        const email = (ctx.body as { email?: string })?.email;
        if (!email) return;
        if (isEmailAllowed(email)) return;

        const exists = await userExistsByEmail(email);
        if (!exists) {
          throw new APIError("FORBIDDEN", {
            message:
              "This app is invite-only. Please ask your administrator to send you an invitation.",
          });
        }
      }

      // Gate 2: Block Email OTP sign-in verification for unknown emails
      // (defense-in-depth — prevents code replay if OTP was somehow obtained)
      if (ctx.path === "/sign-in/email-otp") {
        const email = (ctx.body as { email?: string })?.email;
        if (!email) return;
        if (isEmailAllowed(email)) return;

        const exists = await userExistsByEmail(email);
        if (!exists) {
          throw new APIError("FORBIDDEN", {
            message:
              "This app is invite-only. Please ask your administrator to send you an invitation.",
          });
        }
      }
    }),
  },

  // Organization plugin with ABAC
  plugins: [
    // Passwordless Email OTP sign-in
    emailOTP({
      otpLength: 6,
      expiresIn: 300, // 5 minutes
      async sendVerificationOTP({ email, otp, type }) {
        const skipEmails = (process.env.OTP_SKIP_EMAILS ?? "")
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        if (email.includes("@test.local") || skipEmails.includes(email)) return;
        // Fire-and-forget to avoid timing attacks
        resend.emails
          .send({
            from: serverBrand.mailFrom,
            to: email,
            subject:
              type === "sign-in"
                ? `Your ${serverBrand.appName} sign-in code: ${otp}`
                : `Your ${serverBrand.appName} verification code: ${otp}`,
            html: [
              '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
              `<h2 style="color:#1e293b;margin:0 0 8px">${serverBrand.appName}</h2>`,
              `<p style="color:#64748b;margin:0 0 24px">Your ${type === "sign-in" ? "sign-in" : "verification"} code is:</p>`,
              `<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#6366f1;padding:16px 0">${otp}</div>`,
              '<p style="color:#94a3b8;font-size:13px;margin:24px 0 0">This code expires in 5 minutes.</p>',
              "</div>",
            ].join(""),
          })
          .catch((err) => logger.error("OTP email delivery failed", { email, type, error: err }));
      },
    }),

    // Multi-tenant organization RBAC
    organization({
      ac,
      roles: {
        owner: roles.superuser,
        admin: roles.admin,
        member: roles.member,
        client_approver: roles.clientApprover,
        report_viewer: roles.reportViewer,
      },

      // Invitation email callback
      async sendInvitationEmail(data) {
        const inviteLink = `${process.env.BETTER_AUTH_URL}/organizations/join?code=${data.id}`;
        try {
          await resend.emails.send({
            from: serverBrand.mailFrom,
            to: data.email,
            subject: `You're invited to ${data.organization.name} on ${serverBrand.appName}`,
            html: [
              '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
              `<h2 style="color:#1e293b;margin:0 0 8px">${serverBrand.appName}</h2>`,
              `<p style="color:#64748b">${data.inviter.user.name} invited you to join <strong>${data.organization.name}</strong>.</p>`,
              `<a href="${inviteLink}" style="display:inline-block;padding:12px 24px;background:#0d9488;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;margin:16px 0">Accept Invitation</a>`,
              '<p style="color:#94a3b8;font-size:13px">Or copy this invitation code: ' +
                data.id +
                "</p>",
              "</div>",
            ].join(""),
          });
        } catch (e) {
          logger.error("Failed to send invitation email", {
            email: data.email,
            organizationId: data.organization.id,
            error: e,
          });
        }
      },

      // Only owners can create additional organizations.
      // Members and admins cannot — they must be invited.
      // ADMIN_EMAIL bootstrap: first user with no memberships is allowed.
      allowUserToCreateOrganization: async (user) => {
        const memberships = await db
          .select({ role: authSchema.member.role })
          .from(authSchema.member)
          .where(eq(authSchema.member.userId, user.id));

        // Bootstrap: first user (admin email) with no memberships yet
        if (memberships.length === 0 && adminEmail && user.email === adminEmail) {
          return true;
        }

        // Only owners can create more orgs
        return memberships.some((m) => m.role === "owner");
      },
    }),
  ],

  // Advanced configuration
  advanced: {
    // Use secure cookies only if URL starts with https, otherwise fallback to prod check
    useSecureCookies:
      process.env.BETTER_AUTH_URL?.startsWith("https://") ?? process.env.NODE_ENV === "production",
  },

  // Trust the host header for URL generation
  trustedOrigins: getTrustedOrigins(),
});

// Export invite-only flag for client-side feature toggling via server functions
export const inviteOnlyEnabled = isInviteOnly;

// Export auth type for client-side type inference
export type Auth = typeof auth;
