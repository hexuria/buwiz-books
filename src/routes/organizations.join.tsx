/**
 * Organizations Join — /organizations/join?code=XXX
 *
 * Public-facing invitation landing page. No auth required to view.
 * Embeds inline email OTP sign-in so the invitee can authenticate
 * and accept the invitation in a single flow.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { useSession, organization, authClient, signIn } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";
import { lookupInvitation, acceptInvitationByCode } from "./api/-invitation-lookup";
import { brandInitial } from "@/config/brand";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/organizations/join")({
  component: JoinOrganizationPage,
  validateSearch: (search: Record<string, unknown>) => ({
    code: (search.code as string) ?? "",
  }),
});

/** Gmail-aware email normalization: dots in local part are insignificant */
function normalizeEmail(email: string): string {
  const lower = email.toLowerCase().trim();
  const [local, domain] = lower.split("@");
  if (!domain) return lower;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.replace(/\./g, "")}@gmail.com`;
  }
  return lower;
}

/**
 * Page chrome every state of this flow shares: gradient backdrop, decorative blobs,
 * glass card, brand/org logo. Extracted because the six return branches below carried
 * byte-identical copies of it, so a layout fix had to be made six times to hold.
 */
function JoinShell({ logo, children }: { logo: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="join-page">
      <div style={styles.blobContainer}>
        <div style={{ ...styles.blob, ...styles.blobTop }} />
        <div style={{ ...styles.blob, ...styles.blobBottom }} />
        <div style={{ ...styles.blob, ...styles.blobCenter }} />
      </div>

      <div style={styles.cardWrapper}>
        <div className="join-card">
          <div style={styles.logoRow}>
            <div style={styles.logo}>{logo}</div>
          </div>
          {children}
        </div>
      </div>

      <style>{joinStyles}</style>
    </div>
  );
}

// ============================================================================
// Page
// ============================================================================

type JoinStep = "preview" | "auth" | "accepting" | "success" | "error";
type AuthStep = "email" | "otp";

function JoinOrganizationPage() {
  const { code } = Route.useSearch();
  const { data: session, isPending: sessionPending } = useSession();
  const navigate = useNavigate();

  // ─── State ──────────────────────────────────────────────────────────
  const [step, setStep] = useState<JoinStep>("preview");
  const [authStep, setAuthStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState("");
  const [authError, setAuthError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const acceptingRef = useRef(false);

  // ─── Fetch invitation details ───────────────────────────────────────
  const {
    data: invite,
    isLoading: inviteLoading,
    error: inviteError,
  } = useQuery({
    queryKey: ["invitation-lookup", code],
    queryFn: () =>
      (lookupInvitation as (opts: { data: unknown }) => Promise<any>)({
        data: { code },
      }),
    enabled: !!code,
    retry: false,
    staleTime: 60_000,
  });

  // ─── Countdown ──────────────────────────────────────────────────────
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ─── Auto-accept when session becomes available ─────────────────────
  const handleAcceptInvitation = useCallback(async () => {
    if (acceptingRef.current || !code) return;
    acceptingRef.current = true;
    setStep("accepting");

    try {
      const res = await (acceptInvitationByCode as (opts: { data: unknown }) => Promise<any>)({
        data: { code: code.trim() },
      });

      if (!res?.success) {
        setError("Failed to accept invitation.");
        setStep("error");
        acceptingRef.current = false;
        return;
      }

      // Set active org using the returned org ID
      try {
        await organization.setActive({ organizationId: res.organizationId });
      } catch {
        // Non-critical — OrgGuard will handle
      }

      setStep("success");
      setTimeout(() => {
        navigate({ to: "/" });
      }, 1500);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setError(errMessage || "Failed to accept invitation. Please try again.");
      setStep("error");
      acceptingRef.current = false;
    }
  }, [code, navigate]);

  // When session resolves and we're in preview, check if we can auto-accept
  useEffect(() => {
    if (sessionPending || !invite || acceptingRef.current) return;

    if (session?.user && step === "preview") {
      // User is authenticated — check email match (Gmail-aware)
      const sessNorm = normalizeEmail(session.user.email ?? "");
      const invNorm = normalizeEmail(invite.email ?? "");

      if (sessNorm === invNorm) {
        handleAcceptInvitation();
      }
      // If emails don't match, we stay on preview and show the mismatch message
    }
  }, [session, sessionPending, invite, step, handleAcceptInvitation]);

  // ─── Auth handlers ──────────────────────────────────────────────────

  const handleSendOTP = async () => {
    if (!email.trim() || isSending) return;
    setAuthError("");
    setIsSending(true);

    try {
      const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
      });
      if (sendError) {
        setAuthError(sendError.message || "Failed to send code. Please try again.");
        setIsSending(false);
        return;
      }
      setAuthStep("otp");
      setCountdown(60);
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch {
      setAuthError("Failed to send code. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  const handleVerifyOTP = async (otpValue?: string) => {
    const otpCode = otpValue || otp.join("");
    if (otpCode.length !== 6 || isVerifying) return;
    setAuthError("");
    setIsVerifying(true);

    try {
      const { error: signInError } = await authClient.signIn.emailOtp({
        email: email.trim(),
        otp: otpCode,
      });
      if (signInError) {
        setAuthError(signInError.message || "Invalid code. Please try again.");
        setOtp(["", "", "", "", "", ""]);
        inputRefs.current[0]?.focus();
        setIsVerifying(false);
        return;
      }
      // Session will update via useSession → triggers auto-accept
      setStep("accepting");
      // Wait a bit for session to propagate, then try accepting
      setTimeout(() => {
        handleAcceptInvitation();
      }, 1000);
    } catch {
      setAuthError("Verification failed. Please try again.");
      setIsVerifying(false);
    }
  };

  const handleResendOTP = async () => {
    if (countdown > 0) return;
    setOtp(["", "", "", "", "", ""]);
    setAuthError("");
    setIsSending(true);
    try {
      await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
      });
      setCountdown(60);
    } catch {
      setAuthError("Failed to resend code.");
    } finally {
      setIsSending(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (value.length > 1) {
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
    setAuthError("");
    try {
      await signIn.social({
        provider: "google",
        callbackURL: `/organizations/join?code=${code}`,
      });
    } catch {
      setIsSigningIn(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────

  // No code provided
  if (!code) {
    return (
      <JoinShell logo={brandInitial}>
        <h1 style={styles.title}>Invalid Link</h1>
        <p style={styles.subtitle}>
          No invitation code was provided. Please use the link from your invitation email.
        </p>
      </JoinShell>
    );
  }

  // Loading invitation
  if (inviteLoading || sessionPending) {
    return (
      <JoinShell logo={brandInitial}>
        <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>
          <div className="join-spinner" />
        </div>
        <p style={{ ...styles.subtitle, textAlign: "center" as const }}>Loading invitation…</p>
      </JoinShell>
    );
  }

  // Invitation error (not found, expired, etc.)
  if (inviteError || !invite) {
    const errMsg =
      (inviteError instanceof Error ? inviteError.message : null) ||
      "Invitation not found. It may have been revoked or expired.";
    return (
      <JoinShell logo={brandInitial}>
        <div style={styles.errorIcon}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#dc2626"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h1 style={styles.title}>Invalid Invitation</h1>
        <p style={styles.subtitle}>{errMsg}</p>
        <p className="join-footer" style={{ marginTop: 24, marginBottom: 16 }}>
          Please contact your organization admin to receive a new invitation.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
          <a href="/login" className="join-btn join-btn--primary" style={{ maxWidth: 180 }}>
            Go to Login
          </a>
          <a href="/" className="join-btn join-btn--google" style={{ maxWidth: 180 }}>
            Dashboard
          </a>
        </div>
      </JoinShell>
    );
  }

  // Accepting state
  if (step === "accepting") {
    return (
      <JoinShell logo={invite.orgName?.charAt(0)?.toUpperCase() || brandInitial}>
        <div style={{ display: "flex", justifyContent: "center", padding: "24px 0" }}>
          <div className="join-spinner" />
        </div>
        <h1 style={styles.title}>Joining {invite.orgName}…</h1>
        <p style={styles.subtitle}>Setting up your account. Just a moment.</p>
      </JoinShell>
    );
  }

  // Success state
  if (step === "success") {
    return (
      <JoinShell logo={invite.orgName?.charAt(0)?.toUpperCase() || brandInitial}>
        <div style={styles.successIcon}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#166534"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h1 style={styles.title}>Welcome aboard!</h1>
        <p style={styles.subtitle}>
          You&apos;ve joined <strong>{invite.orgName}</strong>. Redirecting to your dashboard…
        </p>
      </JoinShell>
    );
  }

  // Error state (after acceptance failed)
  if (step === "error") {
    return (
      <JoinShell logo={invite.orgName?.charAt(0)?.toUpperCase() || brandInitial}>
        <div style={styles.errorIcon}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#dc2626"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h1 style={styles.title}>Something went wrong</h1>
        <p style={styles.subtitle}>{error}</p>
        <button
          type="button"
          onClick={() => {
            acceptingRef.current = false;
            setStep("preview");
            setError("");
            setAuthError("");
            setIsVerifying(false);
            setIsSending(false);
            setIsSigningIn(false);
            setAuthStep("email");
            setOtp(["", "", "", "", "", ""]);
          }}
          className="join-btn join-btn--primary"
        >
          Try Again
        </button>
      </JoinShell>
    );
  }

  // ─── Main Preview + Auth State ──────────────────────────────────────

  const isLoggedIn = !!session?.user;
  const emailMismatch =
    isLoggedIn && normalizeEmail(session?.user?.email ?? "") !== normalizeEmail(invite.email ?? "");

  return (
    <JoinShell logo={invite.orgName?.charAt(0)?.toUpperCase() || brandInitial}>
      {/* Invitation header */}
      <div style={styles.header}>
        <h1 style={styles.title}>You&apos;re invited!</h1>
        <p style={styles.subtitle}>
          <strong style={styles.inviterName}>{invite.inviterName}</strong> invited you to join{" "}
          <strong style={styles.orgNameHighlight}>{invite.orgName}</strong> as{" "}
          <span style={styles.roleBadge}>{invite.role}</span>
        </p>
      </div>

      {/* Invitation sent to */}
      <div style={styles.inviteInfoCard}>
        <div style={styles.inviteInfoRow}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "#64748b", flexShrink: 0 }}
          >
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <polyline points="22,6 12,13 2,6" />
          </svg>
          <span style={styles.inviteInfoLabel}>Invitation sent to</span>
          <span style={styles.inviteInfoValue}>{invite.maskedEmail}</span>
        </div>
      </div>

      {/* ── Logged-in email mismatch warning ── */}
      {emailMismatch && (
        <div className="join-alert join-alert--warning">
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
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <p style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>
              Signed in as {session?.user?.email}
            </p>
            <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.8 }}>
              This invitation was sent to a different email. Please sign in with the invited email
              address to accept.
            </p>
          </div>
        </div>
      )}

      {/* ── Authenticated + email matches → show accept button ── */}
      {isLoggedIn && !emailMismatch && (
        <button
          type="button"
          onClick={handleAcceptInvitation}
          className="join-btn join-btn--primary"
        >
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
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Accept Invitation
        </button>
      )}

      {/* ── Not authenticated (or email mismatch) → show inline sign-in ── */}
      {(!isLoggedIn || emailMismatch) && step === "preview" && (
        <>
          <div style={styles.divider}>
            <span style={styles.dividerLine} />
            <span style={styles.dividerText}>
              {emailMismatch ? "Sign in with invited email" : "Sign in to accept"}
            </span>
            <span style={styles.dividerLine} />
          </div>

          {authError && (
            <div className="join-alert join-alert--error">
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
              <span>{authError}</span>
            </div>
          )}

          {authStep === "email" && (
            <>
              <div style={styles.field}>
                <label htmlFor="join-email" style={styles.label}>
                  Email address
                </label>
                <input
                  id="join-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOTP()}
                  placeholder={invite.maskedEmail || "you@company.com"}
                  className="join-input"
                  autoFocus
                  autoComplete="email"
                />
              </div>

              <button
                type="button"
                onClick={handleSendOTP}
                disabled={isSending || !email.trim()}
                className="join-btn join-btn--primary"
              >
                {isSending ? (
                  <>
                    <span className="join-btn-spinner" />
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

              <div style={styles.divider}>
                <span style={styles.dividerLine} />
                <span style={styles.dividerText}>or</span>
                <span style={styles.dividerLine} />
              </div>

              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={isSigningIn}
                className="join-btn join-btn--google"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
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
            </>
          )}

          {authStep === "otp" && (
            <>
              <p style={{ ...styles.subtitle, textAlign: "center" as const, marginBottom: 16 }}>
                We sent a 6-digit code to <strong style={styles.emailHighlight}>{email}</strong>
              </p>

              <div className="join-otp-row">
                {otp.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
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
                    className={`join-otp-input ${digit ? "join-otp-input--filled" : ""}`}
                    autoFocus={i === 0}
                    disabled={isVerifying}
                  />
                ))}
              </div>

              <button
                type="button"
                onClick={() => handleVerifyOTP()}
                disabled={isVerifying || otp.join("").length !== 6}
                className="join-btn join-btn--primary"
              >
                {isVerifying ? (
                  <>
                    <span className="join-btn-spinner" />
                    Verifying…
                  </>
                ) : (
                  "Verify & join"
                )}
              </button>

              <div style={styles.otpActions}>
                <button
                  type="button"
                  onClick={handleResendOTP}
                  disabled={countdown > 0 || isSending}
                  className="join-link"
                >
                  {countdown > 0 ? `Resend code in ${countdown}s` : "Resend code"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthStep("email");
                    setOtp(["", "", "", "", "", ""]);
                    setAuthError("");
                  }}
                  className="join-link"
                >
                  Use a different email
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* Footer */}
      <p className="join-footer">
        By joining, you agree to the organization&apos;s Terms of Service.
      </p>
    </JoinShell>
  );
}

// ============================================================================
// Inline Styles (layout / structure — used as style objects to avoid Tailwind)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  blobContainer: {
    position: "fixed",
    inset: 0,
    pointerEvents: "none",
    overflow: "hidden",
  },
  blob: {
    position: "absolute",
    borderRadius: "50%",
    filter: "blur(80px)",
    opacity: 0.5,
  },
  blobTop: {
    top: -120,
    right: -120,
    width: 420,
    height: 420,
    background: "rgba(13,148,136,0.12)",
  },
  blobBottom: {
    bottom: -120,
    left: -120,
    width: 420,
    height: 420,
    background: "rgba(59,130,246,0.12)",
  },
  blobCenter: {
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    width: 600,
    height: 600,
    background: "rgba(13,148,136,0.05)",
  },
  cardWrapper: {
    position: "relative",
    width: "100%",
    maxWidth: 440,
    zIndex: 1,
  },
  logoRow: {
    display: "flex",
    justifyContent: "center",
    marginBottom: 20,
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: -0.5,
  },
  header: {
    textAlign: "center" as const,
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: -0.3,
    margin: "0 0 8px",
    textAlign: "center" as const,
  },
  subtitle: {
    fontSize: 13.5,
    margin: 0,
    lineHeight: 1.6,
    textAlign: "center" as const,
  },
  inviterName: {
    fontWeight: 600,
  },
  orgNameHighlight: {
    fontWeight: 600,
  },
  roleBadge: {
    display: "inline-block",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 12,
    textTransform: "capitalize" as const,
  },
  inviteInfoCard: {
    borderRadius: 12,
    padding: "12px 16px",
    marginBottom: 20,
  },
  inviteInfoRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    // A long masked address has to wrap onto its own line rather than widen the card.
    flexWrap: "wrap",
  },
  inviteInfoLabel: {
    fontWeight: 500,
  },
  inviteInfoValue: {
    fontFamily: "monospace",
    fontWeight: 600,
    marginLeft: "auto",
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    margin: "20px 0",
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 12,
    fontWeight: 500,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    whiteSpace: "nowrap" as const,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  emailHighlight: {
    fontWeight: 600,
    overflowWrap: "anywhere",
  },
  errorIcon: {
    display: "flex",
    justifyContent: "center",
    marginBottom: 16,
  },
  successIcon: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 16px",
  },
  otpActions: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
};

// ============================================================================
// CSS — themed styles (light/dark, interactions, animations)
// ============================================================================

const joinStyles = /* css */ `
  /* ─── Page ─────────────────────────────────── */
  .join-spinner {
    width: 32px; height: 32px; border-radius: 50%;
    border: 4px solid #e2e8f0; border-top-color: #0d9488;
    animation: join-spin 0.7s linear infinite;
  }
  .dark .join-spinner {
    border-color: rgba(255,255,255,0.1); border-top-color: #0d9488;
  }
  @keyframes join-spin { to { transform: rotate(360deg); } }

  /* ─── Card ─────────────────────────────────── */
  /* Page and card carry real class names because their padding and min-height are now
     breakpoint-dependent, and the [style*=…] selectors this file used to theme them
     matched on the very declarations that had to change. */
  .join-card {
    border-radius: 20px;
    padding: 28px 20px 24px;
    background: rgba(255,255,255,0.85);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid #e2e8f0;
    box-shadow: 0 20px 60px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
  }
  .dark .join-card {
    background: rgba(255,255,255,0.05);
    border-color: rgba(255,255,255,0.1);
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  @media (min-width: 640px) {
    .join-card { padding: 36px 32px 28px; }
  }

  /* ─── Page ─────────────────────────────────── */
  .join-page {
    /* dvh, not vh — mobile browser chrome makes 100vh taller than the visible viewport.
       No overflow rule: hidden used to clip a card taller than the viewport with no way
       to scroll to it. The blobs are already clipped by their own fixed container. */
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    padding-top: calc(16px + env(safe-area-inset-top));
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
    background: linear-gradient(135deg, #f8fafc 0%, #fff 40%, #f0fdfa 100%);
  }
  .dark .join-page,
  :root[data-theme="dark"] .join-page {
    background: linear-gradient(135deg, #0f172a 0%, #0f172a 40%, #042f2e 100%);
  }
  @media (min-width: 640px) {
    .join-page {
      padding-top: 24px;
      padding-bottom: 24px;
      padding-left: 24px;
      padding-right: 24px;
    }
  }

  /* ─── Logo ─────────────────────────────────── */
  [style*="width: 56px"][style*="height: 56px"][style*="border-radius: 16px"] {
    background: linear-gradient(135deg, #0d9488, #0f766e);
    box-shadow: 0 8px 24px rgba(13,148,136,0.3);
  }

  /* ─── Title ─────────────────────────────────── */
  h1[style*="font-size: 22px"] {
    color: #1e293b;
  }
  .dark h1[style*="font-size: 22px"] { color: #fff; }

  /* ─── Subtitle ──────────────────────────────── */
  p[style*="font-size: 13.5px"] {
    color: #64748b;
  }
  .dark p[style*="font-size: 13.5px"] { color: rgba(255,255,255,0.5); }

  /* ─── Invite info card ──────────────────────── */
  [style*="padding: 12px 16px"][style*="margin-bottom: 20px"][style*="border-radius: 12px"] {
    background: #f0fdfa;
    border: 1px solid #99f6e4;
  }
  .dark [style*="padding: 12px 16px"][style*="margin-bottom: 20px"][style*="border-radius: 12px"] {
    background: rgba(13,148,136,0.1);
    border-color: rgba(13,148,136,0.3);
  }

  /* ─── Invite info labels ────────────────────── */
  [style*="font-size: 12px"] span[style*="font-weight: 500"] {
    color: #64748b;
  }
  .dark [style*="font-size: 12px"] span[style*="font-weight: 500"] {
    color: rgba(255,255,255,0.5);
  }
  [style*="font-size: 12px"] span[style*="font-weight: 600"][style*="margin-left: auto"] {
    color: #0d9488;
  }
  .dark [style*="font-size: 12px"] span[style*="font-weight: 600"][style*="margin-left: auto"] {
    color: #2dd4bf;
  }

  /* ─── Role badge ────────────────────────────── */
  span[style*="padding: 2px 8px"][style*="border-radius: 12px"] {
    background: rgba(13,148,136,0.1);
    color: #0d9488;
  }
  .dark span[style*="padding: 2px 8px"][style*="border-radius: 12px"] {
    background: rgba(13,148,136,0.2);
    color: #2dd4bf;
  }

  /* ─── Inviter & org name ────────────────────── */
  strong[style*="font-weight: 600"] {
    color: #1e293b;
  }
  .dark strong[style*="font-weight: 600"] {
    color: #fff;
  }

  /* ─── Success icon ──────────────────────────── */
  [style*="border-radius: 50%"][style*="margin: 0 auto 16px"] {
    background: #dcfce7;
  }
  .dark [style*="border-radius: 50%"][style*="margin: 0 auto 16px"] {
    background: rgba(22,163,74,0.15);
  }

  /* ─── Divider ───────────────────────────────── */
  span[style*="height: 1px"] {
    background: #e2e8f0;
  }
  .dark span[style*="height: 1px"] {
    background: rgba(255,255,255,0.1);
  }
  span[style*="letter-spacing: 0.5px"] {
    color: #94a3b8;
  }
  .dark span[style*="letter-spacing: 0.5px"] {
    color: rgba(255,255,255,0.3);
  }

  /* ─── Labels ────────────────────────────────── */
  label[style*="font-size: 12px"] {
    color: #475569;
  }
  .dark label[style*="font-size: 12px"] {
    color: rgba(255,255,255,0.5);
  }

  /* ─── Footer ────────────────────────────────── */
  .join-footer {
    margin: 24px 0 0;
    text-align: center;
    font-size: 12px;
    line-height: 1.5;
    color: #94a3b8;
  }
  .dark .join-footer {
    color: rgba(255,255,255,0.25);
  }
  @media (min-width: 640px) {
    .join-footer { font-size: 11px; }
  }

  /* ─── Input ─────────────────────────────────── */
  .join-input {
    width: 100%; padding: 12px 14px; border-radius: 12px;
    border: 1.5px solid #e2e8f0; background: #fff;
    /* 16px on phones: iOS Safari zooms the viewport on focus below that and never zooms back. */
    font-size: 16px; color: #1e293b;
    outline: none; transition: all 0.2s;
    box-sizing: border-box;
  }
  @media (min-width: 640px) {
    .join-input { font-size: 15px; }
  }
  .join-input:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.15); }
  .join-input::placeholder { color: #94a3b8; }
  .dark .join-input {
    background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1);
    color: #fff;
  }
  .dark .join-input:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.2); }
  .dark .join-input::placeholder { color: rgba(255,255,255,0.3); }

  /* ─── Buttons ───────────────────────────────── */
  .join-btn {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 12px 16px; border-radius: 12px; border: none;
    font-size: 15px; font-weight: 600; cursor: pointer;
    transition: all 0.2s; outline: none; margin-top: 4px;
    min-height: 44px; text-decoration: none;
  }
  @media (min-width: 1024px) {
    .join-btn { min-height: 0; }
  }
  .join-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .join-btn--primary {
    background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%);
    color: #fff;
    box-shadow: 0 4px 14px rgba(13,148,136,0.35);
  }
  .join-btn--primary:hover:not(:disabled) {
    box-shadow: 0 6px 20px rgba(13,148,136,0.45);
    transform: translateY(-1px);
  }
  .join-btn--google {
    background: #fff; color: #1e293b;
    border: 1.5px solid #e2e8f0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .join-btn--google:hover:not(:disabled) {
    background: #f8fafc;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  .dark .join-btn--google {
    background: rgba(255,255,255,0.08); color: #fff;
    border-color: rgba(255,255,255,0.1);
  }
  .dark .join-btn--google:hover:not(:disabled) {
    background: rgba(255,255,255,0.12);
  }
  .join-btn-spinner {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
    animation: join-spin 0.7s linear infinite;
  }

  /* ─── OTP ───────────────────────────────────── */
  .join-otp-row {
    display: flex; gap: 6px; justify-content: center;
    margin-bottom: 20px;
  }
  .join-otp-input {
    /* Six fixed 48px boxes plus gaps overflow the card at 375px, and the card cannot
       scroll sideways — so they share the row and cap at their desktop size instead. */
    flex: 1 1 0; min-width: 0; max-width: 48px;
    height: 56px; border-radius: 12px;
    border: 1.5px solid #e2e8f0; background: #fff;
    text-align: center; font-size: 22px; font-weight: 700;
    color: #1e293b; outline: none; transition: all 0.2s;
    caret-color: #0d9488;
  }
  @media (min-width: 640px) {
    .join-otp-row { gap: 8px; }
  }
  .join-otp-input:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.15); }
  .join-otp-input--filled { border-color: #0d9488; background: #f0fdfa; }
  .dark .join-otp-input {
    background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1);
    color: #fff;
  }
  .dark .join-otp-input:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.2); }
  .dark .join-otp-input--filled { border-color: #0d9488; background: rgba(13,148,136,0.1); }

  /* ─── Links ─────────────────────────────────── */
  .join-link {
    background: none; border: none; cursor: pointer;
    font-size: 13px; font-weight: 500; color: #0d9488;
    padding: 4px 8px; transition: color 0.15s;
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px;
  }
  @media (min-width: 1024px) {
    .join-link { min-height: 0; padding: 4px 0; }
  }
  .join-link:hover { color: #0f766e; text-decoration: underline; }
  .join-link:disabled { color: #94a3b8; cursor: not-allowed; text-decoration: none; }
  .dark .join-link:disabled { color: rgba(255,255,255,0.3); }

  /* ─── Alerts ────────────────────────────────── */
  .join-alert {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px 16px; border-radius: 12px;
    font-size: 13px; margin-bottom: 16px;
  }
  @media (min-width: 640px) {
    .join-alert { font-size: 12px; }
  }
  .join-alert svg { flex-shrink: 0; margin-top: 1px; }
  /* A long signed-in address must wrap, not widen the card past the viewport. */
  .join-alert > div { min-width: 0; overflow-wrap: anywhere; }
  .join-alert--error {
    background: #fef2f2; border: 1px solid #fecaca; color: #dc2626;
  }
  .dark .join-alert--error {
    background: rgba(220,38,38,0.1); border-color: rgba(220,38,38,0.3); color: #f87171;
  }
  .join-alert--warning {
    background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
  }
  .dark .join-alert--warning {
    background: rgba(146,64,14,0.1); border-color: rgba(146,64,14,0.3); color: #fbbf24;
  }
`;
