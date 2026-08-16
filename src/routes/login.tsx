/**
 * Login Page — /login
 *
 * Two sign-in methods:
 * 1. Email OTP — enter email → receive 6-digit code → enter code → signed in
 * 2. Google OAuth — one-click social sign-in
 *
 * After sign-in: if user has no org memberships → redirect to /onboarding
 *                else set active org and go to /
 */
import { createFileRoute } from "@tanstack/react-router";
import { signIn, useSession, organization, authClient } from "@/lib/auth-client";
import { brand, brandInitial } from "@/config/brand";
import { useEffect, useState, useRef, useCallback } from "react";
import {
  getActiveOrganizationId,
  getResponseList,
  type BetterAuthListResponse,
} from "@/lib/auth-types";
import "@/components/auth/AuthStyles.css";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: (search.redirect as string) || undefined,
  }),
});

type AuthStep = "email" | "otp" | "redirecting";

// Simple email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

function LoginPage() {
  const { redirect: redirectTo } = Route.useSearch();
  const { routeAuth } = Route.useRouteContext();
  const { data: session, isPending } = useSession();
  const orgSetRef = useRef(false);

  // Email OTP state
  const [step, setStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Countdown timer for resend
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // After login: auto-set active org, then redirect
  const handlePostLogin = useCallback(async () => {
    if (orgSetRef.current) return;
    orgSetRef.current = true;

    // If a redirect URL was provided (e.g. from invitation flow), go there
    if (redirectTo) {
      window.location.replace(redirectTo);
      return;
    }

    try {
      const res = await organization.list();
      const orgs = getResponseList(res as BetterAuthListResponse<{ id: string }>);
      if (orgs.length === 0) {
        window.location.replace("/onboarding");
        return;
      }
      await organization.setActive({ organizationId: orgs[0].id });
      window.location.replace("/");
    } catch {
      window.location.replace("/");
    }
  }, [redirectTo]);

  // Watch session for post-login redirect
  useEffect(() => {
    if (!session?.user || isPending || orgSetRef.current) return;

    // If redirect is set, always use it (even if org is already active)
    if (redirectTo) {
      handlePostLogin();
      return;
    }

    const activeOrgId = getActiveOrganizationId(session);
    if (activeOrgId) {
      window.location.replace("/");
      return;
    }

    handlePostLogin();
  }, [session, isPending, handlePostLogin, redirectTo]);

  // ─── Handlers ────────────────────────────────────────────────────────

  const handleSendOTP = async () => {
    if (!email.trim() || isSending) return;

    // Client-side email validation
    if (!isValidEmail(email)) {
      setEmailError("Please enter a valid email address");
      return;
    }

    setError("");
    setEmailError("");
    setIsSending(true);

    try {
      const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
      });
      if (sendError) {
        setError(sendError.message || "Failed to send code. Please try again.");
        setIsSending(false);
        return;
      }
      setStep("otp");
      setCountdown(60);
      // Focus first OTP input
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch {
      setError("Failed to send code. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  const handleVerifyOTP = async (otpValue?: string) => {
    const code = otpValue || otp.join("");
    if (code.length !== 6 || isVerifying) return;
    setError("");
    setIsVerifying(true);

    try {
      const { error: signInError } = await authClient.signIn.emailOtp({
        email: email.trim(),
        otp: code,
      });
      if (signInError) {
        setError(signInError.message || "Invalid code. Please try again.");
        setOtp(["", "", "", "", "", ""]);
        inputRefs.current[0]?.focus();
        setIsVerifying(false);
        return;
      }
      setStep("redirecting");
    } catch {
      setError("Verification failed. Please try again.");
      setIsVerifying(false);
    }
  };

  const handleResendOTP = async () => {
    if (countdown > 0) return;
    setOtp(["", "", "", "", "", ""]);
    setError("");
    setIsSending(true);
    try {
      await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
      });
      setCountdown(60);
    } catch {
      setError("Failed to resend code.");
    } finally {
      setIsSending(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (value.length > 1) {
      // Handle paste
      const digits = value.replace(/\D/g, "").slice(0, 6);
      if (digits.length > 0) {
        const newOtp = [...otp];
        for (let i = 0; i < 6; i++) {
          newOtp[i] = digits[i] || "";
        }
        setOtp(newOtp);
        if (digits.length === 6) {
          handleVerifyOTP(digits);
        } else {
          inputRefs.current[Math.min(digits.length, 5)]?.focus();
        }
        return;
      }
    }

    const digit = value.replace(/\D/g, "").slice(-1);
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits are filled
    if (digit && index === 5) {
      const fullCode = newOtp.join("");
      if (fullCode.length === 6) {
        handleVerifyOTP(fullCode);
      }
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === "Enter") {
      handleVerifyOTP();
    }
  };

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setError("");
    try {
      await signIn.social({
        provider: "google",
        callbackURL: "/login",
      });
    } catch {
      setIsSigningIn(false);
    }
  };

  // Dev-only: one-click sign-in as the configured test account. Hits /api/dev/login, which
  // only works in non-production with DEV_LOGIN_BYPASS=true. On success the session cookie is
  // set and we reload so the session/org guard picks it up.
  const handleDevLogin = async () => {
    setIsSigningIn(true);
    setError("");
    try {
      const res = await fetch("/api/dev/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `Dev login failed (${res.status})`);
      }
      // The dev endpoint creates the same session as a normal OTP login, but it does
      // not run this page's post-login effect because the redirect is immediate. Set
      // the first available organization explicitly so the dashboard and scoped
      // navigation have a valid organization context on the first load.
      const orgRes = await organization.list();
      const orgs = getResponseList(orgRes as BetterAuthListResponse<{ id: string }>);
      if (orgs.length > 0) {
        await organization.setActive({ organizationId: orgs[0].id });
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dev login failed");
      setIsSigningIn(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────

  // The server-backed state keeps the first server/client render identical.
  // Once the client observes a newly authenticated session, latch the page in
  // its loading state even if the route remounts while the redirect resolves.
  if (routeAuth.userId || session?.user || step === "redirecting") {
    return (
      <div className="login-page">
        <div className="login-spinner" />
      </div>
    );
  }

  return (
    <div className="login-page">
      {/* Decorative blobs */}
      <div className="login-blobs">
        <div className="login-blob login-blob--top" />
        <div className="login-blob login-blob--bottom" />
        <div className="login-blob login-blob--center" />
      </div>

      <div className="login-card-wrapper">
        <div className="login-card">
          {/* Logo */}
          <div className="login-logo-row">
            <div className="login-logo">
              <span className="login-logo-letter">{brandInitial}</span>
            </div>
          </div>

          {/* Title */}
          <div className="login-header">
            <h1 className="login-title">
              {step === "otp" ? "Check your email" : `Welcome to ${brand.appName}`}
            </h1>
            <p className="login-subtitle">
              {step === "otp" ? (
                <>
                  We sent a 6-digit code to{" "}
                  <strong className="login-email-highlight">{email}</strong>
                </>
              ) : (
                "Sign in to your accounting dashboard"
              )}
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="login-error" role="alert">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              {error}
            </div>
          )}

          {step === "email" && (
            <>
              {/* Email input */}
              <div className="login-field">
                <label className="login-label" htmlFor="login-email">
                  Email address
                </label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOTP()}
                  placeholder="you@company.com"
                  className={`login-input ${emailError ? "login-input--error" : ""}`}
                  autoFocus
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={emailError ? true : undefined}
                  aria-describedby={emailError ? "login-email-error" : undefined}
                />
                {emailError && (
                  <span className="login-field-error" id="login-email-error">
                    {emailError}
                  </span>
                )}
              </div>

              {/* Send OTP button */}
              <button
                type="button"
                onClick={handleSendOTP}
                disabled={isSending || !email.trim() || !isValidEmail(email)}
                className="login-btn login-btn--primary"
              >
                {isSending ? (
                  <>
                    <span className="login-btn-spinner" />
                    Sending code…
                  </>
                ) : (
                  <>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                      <polyline points="22,6 12,13 2,6" />
                    </svg>
                    Send sign-in code
                  </>
                )}
              </button>

              {/* Divider */}
              <div className="login-divider">
                <span className="login-divider-line" />
                <span className="login-divider-text">or</span>
                <span className="login-divider-line" />
              </div>

              {/* Google button */}
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={isSigningIn}
                className="login-btn login-btn--google"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" className="shrink-0">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                {isSigningIn ? "Signing in…" : "Continue with Google"}
              </button>

              {/* Dev-only one-click login (never rendered in a production build; the
                  server route is also hard-gated on NODE_ENV + DEV_LOGIN_BYPASS). */}
              {import.meta.env.DEV && (
                <button
                  type="button"
                  onClick={handleDevLogin}
                  disabled={isSigningIn}
                  className="login-btn"
                  style={{ marginTop: 8, borderStyle: "dashed", opacity: 0.85 }}
                >
                  🔑 Dev login (test account)
                </button>
              )}
            </>
          )}

          {step === "otp" && (
            <>
              {/* OTP inputs */}
              <div className="login-otp-row">
                {otp.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    // iOS/Android surface the emailed code above the keyboard from this.
                    // Whichever box has focus receives the whole code, which the paste
                    // branch of handleOtpChange already spreads across all six.
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={digit}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
                      if (pasted.length > 1) {
                        e.preventDefault();
                        handleOtpChange(i, pasted);
                      }
                    }}
                    className={`login-otp-input ${digit ? "login-otp-input--filled" : ""}`}
                    aria-label={`One-time password digit ${i + 1}`}
                    autoFocus={i === 0}
                    disabled={isVerifying}
                  />
                ))}
              </div>

              <button
                type="button"
                onClick={() => handleVerifyOTP()}
                disabled={isVerifying || otp.join("").length !== 6}
                className="login-btn login-btn--primary"
              >
                {isVerifying ? (
                  <>
                    <span className="login-btn-spinner" />
                    Verifying…
                  </>
                ) : (
                  "Verify & sign in"
                )}
              </button>

              <div className="login-otp-actions">
                <button
                  type="button"
                  onClick={handleResendOTP}
                  disabled={countdown > 0 || isSending}
                  className="login-link"
                >
                  {countdown > 0 ? `Resend code in ${countdown}s` : "Resend code"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setOtp(["", "", "", "", "", ""]);
                    setError("");
                  }}
                  className="login-link"
                >
                  Use a different email
                </button>
              </div>
            </>
          )}

          {/* Footer */}
          <p className="login-footer">
            By signing in, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}
