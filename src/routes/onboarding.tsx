/**
 * Onboarding Page — /onboarding
 *
 * Multi-step wizard for new users:
 *  Step 1: Welcome — choose "Create Organization" or "Join Organization"
 *  Step 2a: Create Organization form (name, slug, industry, currency, fiscal year end)
 *  Step 2b: Join Organization (enter invitation ID)
 *  Step 3: Success → auto-redirect to /
 *
 * Design: glassmorphism card with gradient blobs, matching login.tsx / profile.tsx
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession, signOut, organization } from "@/lib/auth-client";
import { brand, brandInitial } from "@/config/brand";
import type { BetterAuthDataResponse, BetterAuthListResponse } from "@/lib/auth-types";
import { useState, useEffect, useRef } from "react";
import { getCanCreateOrg } from "./api/-app-config";
import { acceptInvitationByCode } from "./api/-invitation-lookup";
import { applyCoaPreset, listCoaPresets } from "./api/-coa-presets";
import { buildOnboardingStyles } from "./-onboarding-styles";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

// ─── Constants ──────────────────────────────────────────────────────────────────

type OnboardingStep = "welcome" | "create" | "join" | "chart" | "success";

const INDUSTRIES = [
  { value: "technology", label: "Technology" },
  { value: "finance", label: "Finance & Banking" },
  { value: "healthcare", label: "Healthcare" },
  { value: "retail", label: "Retail & E-commerce" },
  { value: "manufacturing", label: "Manufacturing" },
  { value: "professional_services", label: "Professional Services" },
  { value: "real_estate", label: "Real Estate" },
  { value: "education", label: "Education" },
  { value: "nonprofit", label: "Non-profit" },
  { value: "other", label: "Other" },
] as const;

const CURRENCIES = [
  { value: "USD", label: "USD — US Dollar" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "GBP", label: "GBP — British Pound" },
  { value: "CAD", label: "CAD — Canadian Dollar" },
  { value: "AUD", label: "AUD — Australian Dollar" },
  { value: "JPY", label: "JPY — Japanese Yen" },
  { value: "CHF", label: "CHF — Swiss Franc" },
  { value: "PHP", label: "PHP — Philippine Peso" },
  { value: "SGD", label: "SGD — Singapore Dollar" },
  { value: "INR", label: "INR — Indian Rupee" },
] as const;

const FISCAL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// ─── Component ──────────────────────────────────────────────────────────────────

const APP_URL = import.meta.env.VITE_APP_URL || "";
let DOMAIN_NAME = APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
if (!DOMAIN_NAME || DOMAIN_NAME.includes("localhost") || DOMAIN_NAME.includes("127.0.0.1")) {
  DOMAIN_NAME = "buwiz.com";
}

function OnboardingPage() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [error, setError] = useState("");

  // Create org form
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [industry, setIndustry] = useState("technology");
  const [currency, setCurrency] = useState("USD");
  const [fiscalYearEnd, setFiscalYearEnd] = useState("December");

  // Join org form
  const [invitationId, setInvitationId] = useState("");

  const redirectTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Auto-generate slug from name
  useEffect(() => {
    if (!slugTouched && orgName) {
      setOrgSlug(
        orgName
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .slice(0, 48),
      );
    }
  }, [orgName, slugTouched]);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => organization.list(),
    enabled: !!session?.user,
  });

  const canCreateOrgQuery = useQuery({
    queryKey: ["canCreateOrg"],
    queryFn: () =>
      (getCanCreateOrg as (opts: { data: unknown }) => Promise<{ canCreateOrg: boolean }>)({
        data: {},
      }),
  });

  const canCreateOrg = canCreateOrgQuery.data?.canCreateOrg ?? false;

  // Auth guard + org check
  useEffect(() => {
    if (isPending) return;
    if (!session?.user) {
      navigate({ to: "/login", search: { redirect: undefined } });
      return;
    }
    const orgs = (orgsQuery.data as BetterAuthListResponse<{ id: string }>)?.data ?? [];
    if (orgs.length > 0) {
      navigate({ to: "/" });
    }
  }, [session, isPending, navigate, orgsQuery.data]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  // ─── Handlers ───────────────────────────────────────────────────────

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  const presetsQuery = useQuery<{
    recommendedPresetId: string;
    presets: Array<{ id: string; label: string; description: string; accountCount: number }>;
  }>({
    queryKey: ["coa-presets"],
    queryFn: () => (listCoaPresets as (opts: { data: unknown }) => Promise<any>)({ data: {} }),
    enabled: step === "chart",
    staleTime: 5 * 60 * 1000,
  });

  const finishOnboarding = () => {
    setStep("success");
    redirectTimer.current = setTimeout(() => {
      navigate({ to: "/" });
    }, 2000);
  };

  const applyPresetMutation = useMutation({
    mutationFn: async (presetId: string) =>
      (applyCoaPreset as (opts: { data: unknown }) => Promise<unknown>)({
        data: { presetId, options: { onConflict: "renumber" } },
      }),
    onSuccess: () => finishOnboarding(),
    onError: (err: unknown) => {
      // The org exists and is usable; surface the failure but let the user in.
      setError(err instanceof Error ? err.message : "Could not set up the chart of accounts.");
    },
  });

  const createOrgMutation = useMutation({
    mutationFn: async () => {
      setError("");
      const res = await organization.create({
        name: orgName.trim(),
        slug: orgSlug.trim() || orgName.trim().toLowerCase().replace(/\s+/g, "-"),
        metadata: {
          industry,
          currency,
          fiscalYearEnd,
        },
      });

      const typedRes = res as BetterAuthDataResponse<{ id: string }>;
      if (typedRes?.error) {
        throw new Error(typedRes.error.message || "Failed to create organization.");
      }

      // Set as active org
      const orgId = typedRes?.data?.id;
      if (orgId) {
        await organization.setActive({ organizationId: orgId });
      }
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      // A brand-new org has no chart of accounts, and without one it cannot
      // post a bill, an invoice, or a payment — every resolver throws. So the
      // chart step comes before "you're all set", and even Skip applies the
      // baseline rather than leaving the org unusable.
      setStep("chart");
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || "Failed to create organization. Please try again.");
    },
  });

  const joinOrgMutation = useMutation({
    mutationFn: async () => {
      setError("");
      const res = await (acceptInvitationByCode as (opts: { data: unknown }) => Promise<any>)({
        data: { code: invitationId.trim() },
      });

      if (!res?.success) {
        throw new Error("Invalid invitation. Please check and try again.");
      }

      // Set as active org
      if (res.organizationId) {
        await organization.setActive({ organizationId: res.organizationId });
      }
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setStep("success");
      redirectTimer.current = setTimeout(() => {
        navigate({ to: "/" });
      }, 2000);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || "Failed to join organization. Please check your invitation ID.");
    },
  });

  const handleCreateOrg = () => {
    if (!orgName.trim() || createOrgMutation.isPending) return;
    createOrgMutation.mutate();
  };

  const handleJoinOrg = () => {
    if (!invitationId.trim() || joinOrgMutation.isPending) return;
    joinOrgMutation.mutate();
  };

  // ─── Render ─────────────────────────────────────────────────────────

  if (isPending) {
    return (
      <div className="ob-page">
        <div className="ob-spinner" />
        <style>{onboardingStyles}</style>
      </div>
    );
  }

  const stepIndex = step === "welcome" ? 0 : step === "success" ? 2 : 1;

  return (
    <div className="ob-page">
      {/* Decorative blobs */}
      <div className="ob-blobs">
        <div className="ob-blob ob-blob--top" />
        <div className="ob-blob ob-blob--bottom" />
        <div className="ob-blob ob-blob--center" />
      </div>

      <div className="ob-wrapper">
        <div className="ob-card">
          {/* Logo */}
          <div className="ob-logo-row">
            <div className="ob-logo">
              <span className="ob-logo-letter">{brandInitial}</span>
            </div>
          </div>

          {/* Step indicator */}
          {step !== "success" && (
            <div className="ob-steps" role="group" aria-label={`Step ${stepIndex + 1} of 3`}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`ob-step-dot ${i <= stepIndex ? "ob-step-dot--active" : ""} ${i < stepIndex ? "ob-step-dot--done" : ""}`}
                />
              ))}
            </div>
          )}

          {/* ─── Welcome Step ──────────────────────────────────────── */}
          {step === "welcome" && (
            <div className="ob-step-content ob-fade-in">
              <div className="ob-header">
                <h1 className="ob-title">Set up your workspace</h1>
                <p className="ob-subtitle">
                  Get started by creating a new organization or joining an existing one.
                </p>
              </div>

              <div className="ob-paths">
                {/* Create path — only visible for owners */}
                {canCreateOrg && (
                  <button
                    type="button"
                    className="ob-path-card"
                    onClick={() => {
                      setError("");
                      setStep("create");
                    }}
                  >
                    <div className="ob-path-icon ob-path-icon--create">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        <polyline points="9 22 9 12 15 12 15 22" />
                      </svg>
                    </div>
                    <div className="ob-path-text">
                      <span className="ob-path-title">Create Organization</span>
                      <span className="ob-path-desc">
                        Start fresh with a new accounting workspace
                      </span>
                    </div>
                    <svg
                      className="ob-path-arrow"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}

                {/* Join path */}
                <button
                  type="button"
                  className="ob-path-card"
                  onClick={() => {
                    setError("");
                    setStep("join");
                  }}
                >
                  <div className="ob-path-icon ob-path-icon--join">
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="8.5" cy="7" r="4" />
                      <line x1="20" y1="8" x2="20" y2="14" />
                      <line x1="23" y1="11" x2="17" y2="11" />
                    </svg>
                  </div>
                  <div className="ob-path-text">
                    <span className="ob-path-title">Join Organization</span>
                    <span className="ob-path-desc">Accept an invitation to an existing team</span>
                  </div>
                  <svg
                    className="ob-path-arrow"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* ─── Create Organization Step ──────────────────────────── */}
          {step === "create" && (
            <div className="ob-step-content ob-fade-in">
              <div className="ob-header">
                <h1 className="ob-title">Create your organization</h1>
                <p className="ob-subtitle">
                  Tell us about your business so we can set things up for you.
                </p>
              </div>

              {/* Error */}
              {error && <div className="ob-error">{error}</div>}

              {/* Form */}
              <div className="ob-form">
                {/* Org name */}
                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-name">
                    Organization Name
                  </label>
                  <input
                    id="ob-name"
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateOrg()}
                    placeholder="Acme Corp"
                    className="ob-input"
                    autoFocus
                    maxLength={100}
                  />
                </div>

                {/* Slug */}
                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-slug">
                    URL Slug
                  </label>
                  <div className="ob-slug-wrapper">
                    <span className="ob-slug-prefix">{DOMAIN_NAME}/</span>
                    <input
                      id="ob-slug"
                      type="text"
                      value={orgSlug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                      }}
                      placeholder="acme-corp"
                      className="ob-input ob-input--slug"
                      maxLength={48}
                    />
                  </div>
                </div>

                {/* Industry + Currency row */}
                <div className="ob-row">
                  <div className="ob-field ob-field--half">
                    <label className="ob-label" htmlFor="ob-industry">
                      Industry
                    </label>
                    <select
                      id="ob-industry"
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                      className="ob-select"
                    >
                      {INDUSTRIES.map((i) => (
                        <option key={i.value} value={i.value}>
                          {i.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ob-field ob-field--half">
                    <label className="ob-label" htmlFor="ob-currency">
                      Currency
                    </label>
                    <select
                      id="ob-currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className="ob-select"
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Fiscal year end */}
                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-fiscal">
                    Fiscal Year End
                  </label>
                  <select
                    id="ob-fiscal"
                    value={fiscalYearEnd}
                    onChange={(e) => setFiscalYearEnd(e.target.value)}
                    className="ob-select"
                  >
                    {FISCAL_MONTHS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Actions */}
              <div className="ob-actions">
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost"
                  onClick={() => {
                    setError("");
                    setStep("welcome");
                  }}
                  disabled={createOrgMutation.isPending}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn--primary"
                  onClick={handleCreateOrg}
                  disabled={createOrgMutation.isPending || !orgName.trim()}
                >
                  {createOrgMutation.isPending ? (
                    <>
                      <span className="ob-btn-spinner" />
                      Creating…
                    </>
                  ) : (
                    "Create Organization"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ─── Join Organization Step ────────────────────────────── */}
          {step === "join" && (
            <div className="ob-step-content ob-fade-in">
              <div className="ob-header">
                <h1 className="ob-title">Join an organization</h1>
                <p className="ob-subtitle">
                  Enter the invitation ID you received from your team administrator.
                </p>
              </div>

              {/* Error */}
              {error && <div className="ob-error">{error}</div>}

              <div className="ob-form">
                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-invite">
                    Invitation ID
                  </label>
                  <input
                    id="ob-invite"
                    type="text"
                    value={invitationId}
                    onChange={(e) => setInvitationId(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleJoinOrg()}
                    placeholder="Paste your invitation ID here"
                    className="ob-input"
                    autoFocus
                  />
                  <p className="ob-hint">
                    Check your email for an invitation from your team. The ID is included in the
                    email.
                  </p>
                </div>
              </div>

              <div className="ob-actions">
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost"
                  onClick={() => {
                    setError("");
                    setStep("welcome");
                  }}
                  disabled={joinOrgMutation.isPending}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn--primary"
                  onClick={handleJoinOrg}
                  disabled={joinOrgMutation.isPending || !invitationId.trim()}
                >
                  {joinOrgMutation.isPending ? (
                    <>
                      <span className="ob-btn-spinner" />
                      Joining…
                    </>
                  ) : (
                    "Accept Invitation"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ─── Chart of Accounts Step ───────────────────────────── */}
          {step === "chart" && (
            <div className="ob-step-content ob-fade-in">
              <h1 className="ob-title">Set up your chart of accounts</h1>
              <p className="ob-subtitle">
                Pick the template closest to your business. It creates every category you need and
                wires up the default categories for bills, invoices, and bank accounts, so you can
                start recording straight away. You can change any of it later.
              </p>

              {error && <div className="ob-error">{error}</div>}

              <div className="ob-preset-list">
                {(presetsQuery.data?.presets ?? []).map((preset) => {
                  const recommended = preset.id === presetsQuery.data?.recommendedPresetId;
                  const active =
                    (selectedPresetId ?? presetsQuery.data?.recommendedPresetId) === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`ob-preset-card${active ? " ob-preset-card--active" : ""}`}
                      onClick={() => setSelectedPresetId(preset.id)}
                    >
                      <span className="ob-preset-card__title">
                        {preset.label}
                        {recommended && <span className="ob-preset-card__badge">Recommended</span>}
                      </span>
                      <span className="ob-preset-card__desc">{preset.description}</span>
                      <span className="ob-preset-card__meta">{preset.accountCount} categories</span>
                    </button>
                  );
                })}
              </div>

              <div className="ob-actions ob-actions--stacked">
                <button
                  type="button"
                  className="ob-btn ob-btn--primary"
                  disabled={applyPresetMutation.isPending || !presetsQuery.data}
                  onClick={() =>
                    applyPresetMutation.mutate(
                      selectedPresetId ?? presetsQuery.data!.recommendedPresetId,
                    )
                  }
                >
                  {applyPresetMutation.isPending ? "Setting up…" : "Continue"}
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost"
                  disabled={applyPresetMutation.isPending || !presetsQuery.data}
                  onClick={() => applyPresetMutation.mutate("general_small_business")}
                >
                  Skip — use the general template
                </button>
              </div>
            </div>
          )}

          {/* ─── Success Step ─────────────────────────────────────── */}
          {step === "success" && (
            <div className="ob-step-content ob-fade-in">
              <div className="ob-success">
                <div className="ob-success-check">
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h1 className="ob-title">You&#39;re all set!</h1>
                <p className="ob-subtitle">Entering your workspace…</p>
                <div className="ob-success-spinner">
                  <div className="ob-spinner ob-spinner--small" />
                </div>
              </div>
            </div>
          )}

          {/* Sign out link */}
          <button
            type="button"
            className="ob-signout"
            onClick={() =>
              signOut().then(() => navigate({ to: "/login", search: { redirect: undefined } }))
            }
          >
            Sign out
          </button>

          {/* Footer */}
          <p className="ob-footer">Secure accounting workspace powered by {brand.appName}</p>
        </div>
      </div>

      <style>{onboardingStyles}</style>
    </div>
  );
}

// ─── Scoped Styles ──────────────────────────────────────────────────────────────

/**
 * /onboarding is in SIDEBARLESS_ROUTES (__root.tsx), so this page replaces the app shell
 * entirely and is the viewport root.
 */
const onboardingStyles = buildOnboardingStyles("viewport-root");
