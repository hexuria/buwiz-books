/**
 * Profile Page — /profile
 *
 * Displays user account information, linked auth providers,
 * and organization membership.
 * Accessible by clicking the profile area in the sidebar.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useSession,
  authClient,
  organization,
  listAccounts,
  linkSocial,
  unlinkAccount,
} from "@/lib/auth-client";
import { useState, useEffect } from "react";
import { getActiveOrganizationId } from "@/lib/auth-types";
import type { BetterAuthListResponse } from "@/lib/auth-types";
import Combobox from "@/components/ui/Combobox";
import { getTimezoneList, formatTimestampInTz } from "@/lib/timezone";
import { getUserPreferences, updateUserPreferences } from "./api/-user-preferences";
import { listOrgMembers } from "./api/-org-settings";

export const Route = createFileRoute("/profile")({
  component: ProfilePage,
});

/** Provider account shape from better-auth */
interface ProviderAccount {
  providerId: string;
  accountId: string;
  [key: string]: any;
}

function ProfilePage() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [initialTimezone, setInitialTimezone] = useState("UTC");
  const [accountError, setAccountError] = useState("");
  const [unlinkingProvider, setUnlinkingProvider] = useState<string | null>(null);

  useEffect(() => {
    if (session?.user?.name) setName(session.user.name);
  }, [session?.user?.name]);

  // ── Queries ──

  const userPrefsQuery = useQuery({
    queryKey: ["userPreferences"],
    queryFn: () => getUserPreferences(),
  });

  useEffect(() => {
    if (userPrefsQuery.data) {
      setTimezone(userPrefsQuery.data.timezone);
      setInitialTimezone(userPrefsQuery.data.timezone);
    }
  }, [userPrefsQuery.data]);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => organization.list(),
  });

  const activeOrgId = getActiveOrganizationId(session);

  const membersQuery = useQuery({
    queryKey: ["org-members", activeOrgId],
    queryFn: () =>
      (
        listOrgMembers as (opts?: {
          data?: unknown;
        }) => Promise<Array<{ userId: string; role: string }>>
      )(),
    enabled: !!activeOrgId,
  });

  const accountsQuery = useQuery({
    queryKey: ["linkedAccounts"],
    queryFn: () => listAccounts(),
  });

  // ── Mutations ──

  const updateProfileMutation = useMutation({
    mutationFn: async () => {
      await authClient.updateUser({ name: name.trim() });
      if (timezone !== initialTimezone) {
        await (updateUserPreferences as (opts: { data: unknown }) => Promise<unknown>)({
          data: { timezone },
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userPreferences"] });
      if (timezone !== initialTimezone) {
        setInitialTimezone(timezone);
      }
    },
  });

  const linkGoogleMutation = useMutation({
    mutationFn: async () => {
      setAccountError("");
      await linkSocial({ provider: "google", callbackURL: "/profile" });
    },
    onError: () => setAccountError("Failed to link Google account."),
  });

  const unlinkAccountMutation = useMutation({
    mutationFn: async ({ providerId }: { providerId: string }) => {
      setUnlinkingProvider(providerId);
      setAccountError("");
      await unlinkAccount({ providerId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["linkedAccounts"] });
      setUnlinkingProvider(null);
    },
    onError: () => {
      setAccountError("Cannot unlink — you need at least one sign-in method.");
      setUnlinkingProvider(null);
    },
  });

  const handleSave = () => {
    if (!name.trim() || updateProfileMutation.isPending) return;
    updateProfileMutation.mutate();
  };

  const handleLinkGoogle = () => {
    linkGoogleMutation.mutate();
  };

  const handleUnlink = (providerId: string) => {
    unlinkAccountMutation.mutate({ providerId });
  };

  const timezoneOptions = getTimezoneList();

  const handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate({ to: "/" });
    }
  };

  if (isPending) {
    return (
      <div className="profile-page">
        <div className="profile-loading">
          <div className="profile-spinner" />
        </div>
        <style>{profileStyles}</style>
      </div>
    );
  }

  if (!session?.user) {
    navigate({ to: "/login", search: { redirect: undefined } });
    return null;
  }

  const user = session.user;
  const hasChanges = name.trim() !== user.name || timezone !== initialTimezone;

  const orgs =
    (orgsQuery.data as BetterAuthListResponse<{ id: string; name: string; slug: string }>)?.data ??
    [];
  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  const members = membersQuery.data ?? [];
  const me = members.find((m) => m.userId === session?.user?.id);
  const memberRole = me?.role ?? null;

  const accounts = (accountsQuery.data as BetterAuthListResponse<ProviderAccount>)?.data ?? [];
  const accountsLoading = accountsQuery.isPending;

  // Provider helpers
  const hasGoogle = accounts.some((a) => a.providerId === "google");
  const hasEmail = accounts.some(
    (a) => a.providerId === "email-otp" || a.providerId === "credential",
  );
  const canUnlink = accounts.length > 1;

  return (
    <div className="profile-page">
      {/* Header */}
      <header className="profile-header">
        <div className="profile-header-inner">
          <button type="button" onClick={handleGoBack} className="profile-back-btn">
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
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </button>
          <h1 className="profile-header-title">Profile</h1>
          <div style={{ width: 60 }} />
        </div>
      </header>

      <div className="profile-content">
        {/* Avatar + Identity Card */}
        <section className="profile-card">
          <div className="profile-avatar-row">
            {user.image ? (
              <img
                src={user.image}
                alt=""
                className="profile-avatar"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="profile-avatar profile-avatar--fallback">
                {user.name?.charAt(0)?.toUpperCase() ?? "?"}
              </div>
            )}
            <div className="profile-identity">
              <h2 className="profile-name">{user.name}</h2>
              <p className="profile-email">{user.email}</p>
            </div>
          </div>
        </section>

        {/* Edit Name */}
        <section className="profile-card">
          <h3 className="profile-section-title">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="profile-section-icon"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Personal Information
          </h3>

          <div className="profile-field">
            <label className="profile-label" htmlFor="profile-name">
              Display Name
            </label>
            <input
              id="profile-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              className="profile-input"
              placeholder="Your name"
            />
          </div>

          <div className="profile-field">
            <label className="profile-label">Email</label>
            <div className="profile-value-readonly">
              {user.email}
              {user.emailVerified && (
                <span className="profile-badge profile-badge--green">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Verified
                </span>
              )}
            </div>
          </div>

          <div className="profile-field">
            <label className="profile-label">Timezone</label>
            <Combobox
              value={timezone}
              onChange={setTimezone}
              options={timezoneOptions}
              placeholder="Select timezone…"
              searchPlaceholder="Search timezones…"
            />
          </div>

          <div className="profile-actions">
            <button
              type="button"
              onClick={handleSave}
              disabled={updateProfileMutation.isPending || !hasChanges}
              className="profile-btn profile-btn--primary"
            >
              {updateProfileMutation.isPending
                ? "Saving…"
                : updateProfileMutation.isSuccess
                  ? "✓ Saved"
                  : "Update Profile"}
            </button>
          </div>
        </section>

        {/* Linked Accounts */}
        <section className="profile-card">
          <h3 className="profile-section-title">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="profile-section-icon"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Linked Accounts
          </h3>

          {accountError && <div className="profile-account-error">{accountError}</div>}

          {accountsLoading ? (
            <div className="profile-account-loading">
              <div className="profile-spinner profile-spinner--sm" />
              Loading…
            </div>
          ) : (
            <div className="profile-providers">
              {/* Google provider */}
              {hasGoogle ? (
                <div className="profile-provider-row">
                  <div className="profile-provider-info">
                    <div className="profile-provider-icon profile-provider-icon--google">
                      <svg width="18" height="18" viewBox="0 0 24 24">
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
                    </div>
                    <div className="profile-provider-text">
                      <div className="profile-provider-name">Google</div>
                      <div className="profile-provider-detail">Sign in with Google</div>
                    </div>
                  </div>
                  <div className="profile-provider-actions">
                    <span className="profile-badge profile-badge--green">Connected</span>
                    {canUnlink && (
                      <button
                        type="button"
                        onClick={() => handleUnlink("google")}
                        disabled={unlinkingProvider === "google"}
                        className="profile-provider-unlink"
                      >
                        {unlinkingProvider === "google" ? "…" : "Unlink"}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="profile-provider-row profile-provider-row--connect">
                  <div className="profile-provider-info">
                    <div className="profile-provider-icon profile-provider-icon--google">
                      <svg width="18" height="18" viewBox="0 0 24 24">
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
                    </div>
                    <div className="profile-provider-text">
                      <div className="profile-provider-name">Google</div>
                      <div className="profile-provider-detail">Not connected</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleLinkGoogle}
                    disabled={linkGoogleMutation.isPending}
                    className="profile-btn profile-btn--sm"
                  >
                    {linkGoogleMutation.isPending ? "Linking…" : "Link Google"}
                  </button>
                </div>
              )}

              {/* Email provider */}
              {hasEmail && (
                <div className="profile-provider-row">
                  <div className="profile-provider-info">
                    <div className="profile-provider-icon profile-provider-icon--email">
                      <svg
                        width="18"
                        height="18"
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
                    </div>
                    <div className="profile-provider-text">
                      <div className="profile-provider-name">Email</div>
                      <div className="profile-provider-detail">Sign in with verification code</div>
                    </div>
                  </div>
                  <span className="profile-badge profile-badge--green">Connected</span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Organization */}
        <section className="profile-card">
          <h3 className="profile-section-title">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="profile-section-icon"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Organization
          </h3>

          {activeOrg ? (
            <div className="profile-org">
              <div className="profile-org-icon">
                {activeOrg.name?.charAt(0)?.toUpperCase() ?? "O"}
              </div>
              <div className="profile-org-info">
                <div className="profile-org-name">{activeOrg.name}</div>
                <div className="profile-org-meta">
                  <span className="profile-badge profile-badge--blue">
                    {memberRole ?? "member"}
                  </span>
                  {activeOrg.slug && <span className="profile-org-slug">@{activeOrg.slug}</span>}
                </div>
              </div>
            </div>
          ) : (
            <p className="profile-empty">No active organization</p>
          )}

          {orgs.length > 1 && (
            <div className="profile-org-list">
              <p className="profile-org-list-label">All organizations</p>
              {orgs.map((org) => (
                <div
                  key={org.id}
                  className={`profile-org-item ${org.id === activeOrgId ? "profile-org-item--active" : ""}`}
                >
                  <div className="profile-org-item-icon">
                    {org.name?.charAt(0)?.toUpperCase() ?? "O"}
                  </div>
                  <span className="profile-org-item-name">{org.name}</span>
                  {org.id === activeOrgId && (
                    <span
                      className="profile-badge profile-badge--green"
                      style={{ marginLeft: "auto" }}
                    >
                      Active
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Account Info */}
        <section className="profile-card">
          <h3 className="profile-section-title">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="profile-section-icon"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Account
          </h3>
          <div className="profile-detail-grid">
            <div className="profile-detail">
              <span className="profile-detail-label">User ID</span>
              <span className="profile-detail-value profile-detail-value--mono">{user.id}</span>
            </div>
            <div className="profile-detail">
              <span className="profile-detail-label">Member since</span>
              <span className="profile-detail-value">
                {user.createdAt
                  ? formatTimestampInTz(
                      user.createdAt instanceof Date
                        ? user.createdAt.toISOString()
                        : String(user.createdAt),
                      timezone,
                      {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: undefined,
                        minute: undefined,
                      },
                    )
                  : "—"}
              </span>
            </div>
          </div>
        </section>
      </div>

      <style>{profileStyles}</style>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const profileStyles = /* css */ `
  /* This route renders *inside* the app shell (it is not in SIDEBARLESS_ROUTES), and the shell is
     "flex h-dvh overflow-hidden" with its own scrollport between the mobile app bar and the bottom
     tab bar. A 100vh box here would overrun that scrollport by the height of both bars and turn
     this page into a second, nested scroller. 100% fills the scrollport exactly; flex-shrink: 0
     stops the flex parent squeezing it below its content once the sections are taller. */
  .profile-page {
    display: flex; flex-direction: column;
    min-height: 100%; flex-shrink: 0;
    background: #f1f5f9;
  }
  .dark .profile-page { background: #0c1322; }

  .profile-loading {
    display: flex; align-items: center; justify-content: center;
    flex: 1;
  }
  .profile-spinner {
    width: 32px; height: 32px; border-radius: 50%;
    border: 4px solid #e2e8f0; border-top-color: #6366f1;
    animation: prof-spin 0.7s linear infinite;
  }
  .profile-spinner--sm {
    width: 16px; height: 16px;
    border-width: 2px;
  }
  .dark .profile-spinner { border-color: rgba(255,255,255,0.1); border-top-color: #6366f1; }
  @keyframes prof-spin { to { transform: rotate(360deg); } }

  /* Header */
  .profile-header {
    position: sticky; top: 0; z-index: 40;
    background: rgba(255,255,255,0.85); backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-bottom: 1px solid #e2e8f0;
  }
  .dark .profile-header { background: rgba(17,24,39,0.85); border-bottom-color: rgba(255,255,255,0.1); }
  .profile-header-inner {
    max-width: 640px; margin: 0 auto;
    /* Landscape on a notched phone insets one side and the shell's content column does not pad
       it — the sidebar there is an off-canvas drawer, so this page spans the full width. */
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
    height: 56px; display: flex; align-items: center; justify-content: space-between;
  }
  @media (min-width: 640px) {
    .profile-header-inner {
      padding-left: max(24px, env(safe-area-inset-left));
      padding-right: max(24px, env(safe-area-inset-right));
    }
  }
  .profile-header-title {
    font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;
  }
  .dark .profile-header-title { color: #fff; }
  .profile-back-btn {
    display: flex; align-items: center; gap: 4px;
    font-size: 14px; font-weight: 500; color: #6366f1;
    background: none; border: none; cursor: pointer;
    /* 44px for the thumb; the negative margin cancels the added padding so the label still
       lines up with the page gutter. */
    min-height: 44px; padding: 4px 8px; margin-left: -8px;
    transition: color 0.15s;
  }
  .profile-back-btn:hover { color: #4f46e5; }

  /* Content */
  .profile-content {
    max-width: 640px; margin: 0 auto;
    padding: 16px max(16px, env(safe-area-inset-right)) 24px max(16px, env(safe-area-inset-left));
    display: flex; flex-direction: column; gap: 16px;
  }
  @media (min-width: 640px) {
    .profile-content {
      padding: 24px max(24px, env(safe-area-inset-right)) 32px max(24px, env(safe-area-inset-left));
    }
  }

  /* Card */
  .profile-card {
    background: #fff; border-radius: 16px;
    border: 1px solid #e2e8f0; padding: 16px;
  }
  @media (min-width: 640px) {
    .profile-card { padding: 24px; }
  }
  .dark .profile-card { background: #1e293b; border-color: rgba(255,255,255,0.1); }

  /* Avatar row */
  .profile-avatar-row { display: flex; align-items: center; gap: 16px; }
  .profile-avatar {
    width: 64px; height: 64px; border-radius: 50%;
    object-fit: cover; flex-shrink: 0;
  }
  .profile-avatar--fallback {
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff; font-size: 24px; font-weight: 700;
  }
  .profile-identity { min-width: 0; }
  .profile-name {
    font-size: 20px; font-weight: 700; color: #1e293b;
    margin: 0 0 2px; word-break: break-word;
  }
  .dark .profile-name { color: #fff; }
  .profile-email {
    font-size: 14px; color: #64748b; margin: 0;
    overflow-wrap: anywhere;
  }
  .dark .profile-email { color: rgba(255,255,255,0.5); }

  /* Section title */
  .profile-section-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 14px; font-weight: 600; color: #1e293b;
    margin: 0 0 16px;
  }
  .dark .profile-section-title { color: #fff; }
  .profile-section-icon { color: #6366f1; flex-shrink: 0; }

  /* Fields */
  .profile-field { margin-bottom: 14px; }
  .profile-label {
    display: block; font-size: 12px; font-weight: 600;
    color: #64748b; margin-bottom: 6px;
  }
  .dark .profile-label { color: rgba(255,255,255,0.5); }
  .profile-input {
    width: 100%; padding: 10px 14px; border-radius: 10px;
    border: 1.5px solid #e2e8f0; background: #fff;
    /* 16px on phones: iOS Safari zooms the viewport on focus below that and never zooms back. */
    font-size: 16px; color: #1e293b; outline: none;
    min-height: 44px;
    transition: all 0.2s; box-sizing: border-box;
  }
  @media (min-width: 640px) {
    .profile-input { font-size: 14px; min-height: 0; }
  }

  /* No Combobox overrides here. It carries its own 44px rows / 16px search field below 640px and
     desktop density above, and its list is portalled to document.body — a descendant selector
     scoped to this page would no longer reach the options anyway. */
  .profile-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.12); }
  .dark .profile-input {
    background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1);
    color: #fff;
  }
  .dark .profile-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.2); }

  .profile-value-readonly {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-radius: 10px;
    background: #f8fafc; border: 1.5px solid #e2e8f0;
    font-size: 14px; color: #64748b;
  }
  .dark .profile-value-readonly {
    background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.5);
  }

  /* Actions */
  .profile-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  @media (min-width: 640px) {
    .profile-actions { flex-direction: row; }
  }
  .profile-btn {
    padding: 10px 20px; border-radius: 10px; border: none;
    font-size: 14px; font-weight: 600; cursor: pointer;
    min-height: 44px;
    transition: all 0.2s;
  }
  /* Full-width is a deliberate choice for the form's primary submit on a phone, not a fallback —
     so it is scoped to .profile-actions and never reaches the inline "Link Google" button. */
  .profile-actions .profile-btn { width: 100%; }
  @media (min-width: 640px) {
    .profile-btn { min-height: 0; }
    .profile-actions .profile-btn { width: auto; }
  }
  .profile-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .profile-btn--primary {
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff; box-shadow: 0 2px 8px rgba(99,102,241,0.25);
  }
  .profile-btn--primary:hover:not(:disabled) {
    box-shadow: 0 4px 14px rgba(99,102,241,0.35);
    transform: translateY(-1px);
  }
  .profile-btn--sm {
    padding: 6px 14px; border-radius: 8px;
    font-size: 13px; font-weight: 600;
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff; box-shadow: 0 1px 4px rgba(99,102,241,0.2);
    white-space: nowrap;
  }
  .profile-btn--sm:hover:not(:disabled) {
    box-shadow: 0 2px 8px rgba(99,102,241,0.35);
    transform: translateY(-1px);
  }

  /* Badge */
  .profile-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; border-radius: 6px;
    font-size: 12px; font-weight: 600; text-transform: capitalize;
    white-space: nowrap;
  }
  @media (min-width: 640px) {
    .profile-badge { padding: 2px 8px; font-size: 11px; }
  }
  .profile-badge--green { background: #dcfce7; color: #16a34a; }
  .dark .profile-badge--green { background: rgba(22,163,74,0.15); color: #4ade80; }
  .profile-badge--blue { background: #dbeafe; color: #2563eb; }
  .dark .profile-badge--blue { background: rgba(37,99,235,0.15); color: #60a5fa; }

  /* Linked Accounts */
  .profile-providers {
    display: flex; flex-direction: column; gap: 10px;
  }
  /* Icon + two lines of copy + a badge + "Unlink" needs ~350px; the card interior is 311px at
     375. Stack below sm so nothing squashes, and keep flex-start so the connect button sizes to
     its label instead of stretching the full row. */
  .profile-provider-row {
    display: flex; flex-direction: column; align-items: flex-start; gap: 12px;
    padding: 14px 16px; border-radius: 12px;
    background: #f8fafc; border: 1px solid #e2e8f0;
    transition: background 0.15s;
  }
  @media (min-width: 640px) {
    .profile-provider-row {
      flex-direction: row; align-items: center; justify-content: space-between; gap: 12px;
    }
  }
  .profile-provider-row--connect {
    background: #fafafa; border-style: dashed;
  }
  .dark .profile-provider-row {
    background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08);
  }
  .dark .profile-provider-row--connect {
    background: rgba(255,255,255,0.02);
  }
  .profile-provider-info {
    display: flex; align-items: center; gap: 12px;
    flex: 1; min-width: 0;
  }
  .profile-provider-text { min-width: 0; }
  .profile-provider-icon {
    width: 36px; height: 36px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .profile-provider-icon--google { background: #fff; border: 1px solid #e2e8f0; }
  .dark .profile-provider-icon--google { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.15); }
  .profile-provider-icon--email { background: #eff6ff; color: #3b82f6; }
  .dark .profile-provider-icon--email { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .profile-provider-name {
    font-size: 14px; font-weight: 600; color: #1e293b;
    overflow-wrap: anywhere;
  }
  .dark .profile-provider-name { color: #fff; }
  .profile-provider-detail {
    font-size: 12px; color: #94a3b8; margin-top: 1px;
    overflow-wrap: anywhere;
  }
  .dark .profile-provider-detail { color: rgba(255,255,255,0.35); }
  .profile-provider-actions {
    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  }
  .profile-provider-unlink {
    background: none; border: none; cursor: pointer;
    font-size: 12px; font-weight: 500; color: #ef4444;
    min-height: 44px; padding: 8px 12px; border-radius: 6px; transition: all 0.15s;
  }
  @media (min-width: 640px) {
    .profile-provider-unlink { min-height: 0; padding: 4px 8px; }
  }
  .profile-provider-unlink:hover { background: rgba(239,68,68,0.08); }
  .profile-provider-unlink:disabled { opacity: 0.5; cursor: not-allowed; }

  .profile-account-error {
    padding: 10px 14px; border-radius: 10px;
    background: #fef2f2; border: 1px solid #fecaca;
    color: #dc2626; font-size: 13px; font-weight: 500;
    margin-bottom: 12px;
  }
  .dark .profile-account-error {
    background: rgba(220,38,38,0.1); border-color: rgba(220,38,38,0.3); color: #f87171;
  }
  .profile-account-loading {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; color: #94a3b8;
  }

  /* Org */
  .profile-org {
    display: flex; align-items: center; gap: 12px;
    padding: 12px; border-radius: 12px; background: #f8fafc;
    border: 1px solid #e2e8f0;
  }
  .dark .profile-org {
    background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08);
  }
  .profile-org-icon {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    color: #fff; font-size: 16px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .profile-org-info { min-width: 0; }
  .profile-org-name {
    font-size: 15px; font-weight: 600; color: #1e293b;
    overflow-wrap: anywhere;
  }
  .dark .profile-org-name { color: #fff; }
  .profile-org-meta {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 4px;
  }
  .profile-org-slug { font-size: 12px; color: #94a3b8; overflow-wrap: anywhere; }
  .dark .profile-org-slug { color: rgba(255,255,255,0.35); }

  .profile-empty { font-size: 14px; color: #94a3b8; margin: 0; }
  .dark .profile-empty { color: rgba(255,255,255,0.35); }

  .profile-org-list { margin-top: 16px; }
  .profile-org-list-label {
    font-size: 12px; font-weight: 600; color: #94a3b8;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  @media (min-width: 640px) {
    .profile-org-list-label { font-size: 11px; }
  }
  .dark .profile-org-list-label { color: rgba(255,255,255,0.35); }
  .profile-org-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: 8px;
    transition: background 0.15s;
  }
  .profile-org-item:hover { background: #f1f5f9; }
  .dark .profile-org-item:hover { background: rgba(255,255,255,0.05); }
  .profile-org-item--active { background: #f0f9ff; }
  .dark .profile-org-item--active { background: rgba(99,102,241,0.08); }
  .profile-org-item-icon {
    width: 28px; height: 28px; border-radius: 6px;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    color: #fff; font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  /* Truncate rather than wrap: a long org name would otherwise push the "Active" badge, which is
     pinned with margin-left: auto, off the right edge of the row. */
  .profile-org-item-name {
    font-size: 13px; font-weight: 500; color: #1e293b;
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dark .profile-org-item-name { color: #fff; }

  /* Detail grid */
  .profile-detail-grid {
    display: grid; grid-template-columns: 1fr; gap: 12px;
  }
  @media (min-width: 640px) {
    /* Half of a 375px card is ~140px, which breaks a 36-char user ID across four lines. */
    .profile-detail-grid { grid-template-columns: 1fr 1fr; }
  }
  .profile-detail { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .profile-detail-label { font-size: 12px; font-weight: 600; color: #94a3b8; }
  .dark .profile-detail-label { color: rgba(255,255,255,0.4); }
  .profile-detail-value { font-size: 13px; color: #1e293b; word-break: break-all; }
  .dark .profile-detail-value { color: rgba(255,255,255,0.7); }
  .profile-detail-value--mono { font-family: monospace; font-size: 12px; }
  @media (min-width: 640px) {
    .profile-detail-label { font-size: 11px; }
    .profile-detail-value--mono { font-size: 11px; }
  }
`;
