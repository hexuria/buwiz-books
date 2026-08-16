import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSession, organization } from "@/lib/auth-client";
import type { BetterAuthDataResponse } from "@/lib/auth-types";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getCanCreateOrg } from "./api/-app-config";

export const Route = createFileRoute("/create-organization")({
  component: CreateOrganizationPage,
});

// ─── Constants ──────────────────────────────────────────────────────────────────

import { INDUSTRIES, CURRENCIES, FISCAL_MONTHS } from "@/lib/constants";
import { applyCoaPreset } from "./api/-coa-presets";
import { buildOnboardingStyles } from "./-onboarding-styles";
import { presetForIndustry } from "@/lib/coa/presets";

/** Pure, so this route does not need a round trip just to pick a default. */
function recommendedPresetFor(industry: string): string {
  return presetForIndustry(industry).id;
}

const APP_URL = import.meta.env.VITE_APP_URL || "";
let DOMAIN_NAME = APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
if (!DOMAIN_NAME || DOMAIN_NAME.includes("localhost") || DOMAIN_NAME.includes("127.0.0.1")) {
  DOMAIN_NAME = "buwiz.com";
}

// ─── Component ──────────────────────────────────────────────────────────────────

function CreateOrganizationPage() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  // Create org form
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [industry, setIndustry] = useState("technology");
  const [currency, setCurrency] = useState("USD");
  const [fiscalYearEnd, setFiscalYearEnd] = useState("December");

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

  // Auth guard
  useEffect(() => {
    if (isPending) return;
    if (!session?.user) {
      navigate({ to: "/login", search: { redirect: undefined } });
    }
  }, [session, isPending, navigate]);

  // Org creation guard — only owners can access this route
  useEffect(() => {
    (getCanCreateOrg as (opts: { data: unknown }) => Promise<{ canCreateOrg: boolean }>)({
      data: {},
    }).then((res) => {
      if (!res.canCreateOrg) {
        navigate({ to: "/" });
      }
    });
  }, [navigate]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  const handleCreateOrg = useCallback(async () => {
    if (!orgName.trim() || isSubmitting) return;
    setError("");
    setIsSubmitting(true);

    try {
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
        setError(typedRes.error.message || "Failed to create organization.");
        setIsSubmitting(false);
        return;
      }

      // Set as active org
      const orgId = typedRes?.data?.id;
      if (orgId) {
        // Clear stale query cache from the previous active org
        queryClient.clear();
        await organization.setActive({ organizationId: orgId });
      }

      // A new org with no chart of accounts cannot post a bill, an invoice, or
      // a payment — every resolver throws. This route has no template-picker
      // step (it is the "create another org" flow, not first-run onboarding),
      // so apply the industry-recommended pack automatically. It is additive
      // and idempotent, and the user can apply a different template from the
      // Category Manager afterwards.
      if (orgId) {
        try {
          await (applyCoaPreset as (opts: { data: unknown }) => Promise<unknown>)({
            data: {
              presetId: recommendedPresetFor(industry),
              options: { onConflict: "renumber" },
            },
          });
        } catch {
          // The org exists and is usable; the Category Manager offers the same
          // templates. Do not block entry on this.
        }
      }

      setSuccess(true);
      redirectTimer.current = setTimeout(() => {
        navigate({ to: "/" });
      }, 2000);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      setError(errMessage || "Failed to create organization. Please try again.");
      setIsSubmitting(false);
    }
  }, [orgName, orgSlug, industry, currency, fiscalYearEnd, isSubmitting, navigate]);

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate({ to: "/" });
    }
  };

  if (isPending) {
    return (
      <div className="ob-page">
        <div className="ob-spinner" />
        <style>{onboardingStyles}</style>
      </div>
    );
  }

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
          {success ? (
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
                <h1 className="ob-title">Organization Created!</h1>
                <p className="ob-subtitle">Switching context…</p>
                <div className="ob-success-spinner">
                  <div className="ob-spinner ob-spinner--small" />
                </div>
              </div>
            </div>
          ) : (
            <div className="ob-step-content ob-fade-in">
              <div className="ob-header">
                <h1 className="ob-title">Create New Organization</h1>
                <p className="ob-subtitle">Set up a new workspace for your business or project.</p>
              </div>

              {/* Error */}
              {error && (
                <div className="ob-error" role="alert">
                  {error}
                </div>
              )}

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
                    autoComplete="organization"
                    autoCapitalize="words"
                  />
                </div>

                {/* Slug */}
                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-slug">
                    URL Slug
                  </label>
                  <div className="ob-slug-wrapper">
                    <span className="ob-slug-prefix" title={`${DOMAIN_NAME}/`}>
                      {DOMAIN_NAME}/
                    </span>
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
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
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

              {/* Actions. The primary is first in the DOM so it stacks on top when the
                  row breaks on a phone; `.ob-actions` uses row-reverse from `sm` up to
                  keep the desktop arrangement (Cancel left, Create right) unchanged. */}
              <div className="ob-actions">
                <button
                  type="button"
                  className="ob-btn ob-btn--primary"
                  onClick={handleCreateOrg}
                  disabled={isSubmitting || !orgName.trim()}
                >
                  {isSubmitting ? (
                    <>
                      <span className="ob-btn-spinner" />
                      Creating…
                    </>
                  ) : (
                    "Create Organization"
                  )}
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn--ghost"
                  onClick={handleBack}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{onboardingStyles}</style>
    </div>
  );
}

// ─── Scoped Styles ──────────────────────────────────────────────────────────────

/**
 * Unlike /login and /onboarding, /create-organization is NOT in SIDEBARLESS_ROUTES
 * (__root.tsx) — it renders inside AppSidebar's scroll region, which below lg also carries
 * the app bar and the bottom tab bar.
 */
const onboardingStyles = buildOnboardingStyles("inside-app-shell");
