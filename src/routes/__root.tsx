import { HeadContent, Scripts, createRootRoute, redirect } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";

import AppSidebar from "../components/AppSidebar";
import { SidebarProvider, useSidebar } from "../components/SidebarContext";
import { ThemeProvider } from "../components/ThemeContext";
import { ToastProvider } from "../components/ui/Toast";
import { useSession, signOut, organization } from "../lib/auth-client";
import { getActiveOrganizationId, getResponseList } from "../lib/auth-types";
import { getRenderedRoutePathname, isPublicRoutePath } from "../lib/route-access";
import { getAppConfig } from "./api/-app-config";
import { getRouteAuthState } from "./api/-route-auth";
import { getChartStatus } from "./api/-coa-presets";
import { brand } from "../config/brand";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const routeAuth = await getRouteAuthState();

    if (!routeAuth.userId && !isPublicRoutePath(location.pathname)) {
      throw redirect({
        to: "/login",
        search: { redirect: undefined },
        replace: true,
      });
    }

    return { routeAuth };
  },

  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        // `viewport-fit=cover` lets the app paint under the notch and home indicator in iOS
        // standalone mode. Fixed chrome then has to pad itself out with the `*-safe` utilities
        // in styles.css — without the cover, those insets are always 0 and the app is letterboxed.
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        // Matches the sidebar/app-bar surface so the iOS status bar blends with the chrome.
        name: "theme-color",
        content: "#0f172a",
      },
      {
        name: "apple-mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
      {
        name: "apple-mobile-web-app-title",
        content: brand.appName,
      },
      {
        title: brand.appName,
      },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: brand.faviconUrl,
      },
      {
        rel: "icon",
        type: "image/x-icon",
        href: "/favicon.ico",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "manifest",
        href: "/manifest.webmanifest",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
});

/** Routes that skip the sidebar shell (standalone layouts like login) */
const SIDEBARLESS_ROUTES = [
  "/login",
  "/onboarding",
  "/transactions/new",
  "/invoices/draft/",
  "/invoices/pay/",
  "/organization/",
  "/organizations/join",
  "/reconciliations/",
];

/** Routes that skip the organization guard */
/**
 * Where the empty-chart redirect must never fire: the destination itself, and
 * any flow that legitimately runs before a chart exists. Without this the user
 * cannot escape the redirect.
 */
const CHART_REDIRECT_SKIP_ROUTES = ["/accounts", "/onboarding", "/create-organization", "/login"];

const ORG_GUARD_SKIP_ROUTES = [
  "/login",
  "/onboarding",
  "/profile",
  "/organizations/join",
  "/invoices/pay/",
];

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("buwiz-theme");var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark");else document.documentElement.classList.remove("dark");document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <ServiceWorkerRegistration />
        <AppErrorBoundary contextLabel="Application">
          <ThemeProvider>
            <SidebarProvider>
              <ToastProvider>
                <RootLayout>{children}</RootLayout>
              </ToastProvider>
            </SidebarProvider>
          </ThemeProvider>
        </AppErrorBoundary>
        {import.meta.env.VITE_DEVTOOLS === "true" && (
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Registers the service worker that makes the app installable.
 *
 * Production only. In dev the worker would sit in front of Vite's module graph and serve stale
 * assets through HMR, which reads as "my edit did nothing". Registration is also deferred to
 * `load` so it never competes with the first paint.
 *
 * See `public/sw.js` for why the caching policy is as conservative as it is.
 */
function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // An unregistrable worker costs the install prompt, not the app. Stay silent.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: getRenderedRoutePathname });
  const { collapsed, toggle } = useSidebar();
  const hideSidebar = SIDEBARLESS_ROUTES.some((r) => pathname.startsWith(r));

  if (hideSidebar) {
    return <OrgGuard>{children}</OrgGuard>;
  }

  return (
    <OrgGuard>
      <AppSidebar collapsed={collapsed} onToggleCollapse={toggle}>
        {children}
      </AppSidebar>
    </OrgGuard>
  );
}

/**
 * Organization guard — redirects authenticated users to /onboarding
 * if they don't belong to any organization.
 */
function OrgGuard({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: getRenderedRoutePathname });
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession();
  const [orgChecked, setOrgChecked] = useState(false);
  const checkingRef = useRef(false);
  const lastCheckedUserRef = useRef<string | null>(null);
  // Track whether initial check has ever passed — prevents spinner flash on SPA navigation
  const initialCheckDoneRef = useRef(false);
  // The empty-chart redirect fires at most once per session, not on every route
  // change — otherwise a user who navigates away is dragged back repeatedly.
  const chartCheckedRef = useRef(false);

  const skipGuard = ORG_GUARD_SKIP_ROUTES.some((r) => pathname.startsWith(r));

  // Reset guard when user identity changes (e.g., org switch or re-login)
  useEffect(() => {
    const currentUserId = session?.user?.id ?? null;
    if (currentUserId !== lastCheckedUserRef.current) {
      setOrgChecked(false);
      initialCheckDoneRef.current = false;
      chartCheckedRef.current = false;
      lastCheckedUserRef.current = currentUserId;
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (skipGuard) {
      setOrgChecked(true);
      return;
    }

    // Still loading session — keep showing spinner
    if (sessionPending) return;

    // Session resolved but no authenticated user — redirect to login
    if (!session?.user) {
      navigate({ to: "/login" as string & {} });
      return;
    }

    // Prevent duplicate in-flight checks
    if (checkingRef.current) return;
    checkingRef.current = true;

    // Re-check membership on every route change to catch mid-session removal
    Promise.all([
      organization.list(),
      (getAppConfig as (opts: { data: unknown }) => Promise<{ inviteOnly: boolean }>)({
        data: {},
      }),
    ])
      .then(async ([orgRes, config]) => {
        const orgs = getResponseList(orgRes);
        if (orgs.length === 0) {
          if (config.inviteOnly) {
            // Removed member in invite-only mode — sign out
            signOut().then(() => navigate({ to: "/login" as string & {} }));
          } else {
            // Public mode — redirect to onboarding to create org
            navigate({ to: "/onboarding" as string & {} });
          }
        } else {
          // Better Auth may serve a stale cookie-cached session in a newly opened tab
          // even though the database session already has an active organization. Repair
          // that client state before rendering organization-scoped queries and branding.
          if (!getActiveOrganizationId(session)) {
            await organization.setActive({ organizationId: orgs[0].id });
            await refetchSession();
          }

          setOrgChecked(true);
          initialCheckDoneRef.current = true;

          // An org with no chart of accounts cannot post anything — every
          // resolver throws. Send it to the Category Manager, whose empty state
          // offers the preset picker.
          //
          // Fails SAFE by construction: this only ever redirects on a
          // definitive `hasAccounts === false`. A rejected or slow call leaves
          // the user exactly where they are, because stranding a working user
          // on a setup screen is worse than missing the nudge.
          if (
            !chartCheckedRef.current &&
            !CHART_REDIRECT_SKIP_ROUTES.some((r) => pathname.startsWith(r))
          ) {
            chartCheckedRef.current = true;
            (getChartStatus as (opts: { data: unknown }) => Promise<{ hasAccounts: boolean }>)({
              data: {},
            })
              .then((status) => {
                if (status?.hasAccounts === false) {
                  navigate({ to: "/accounts" as string & {} });
                }
              })
              .catch(() => {
                // Never redirect on failure; allow a later pass to retry.
                chartCheckedRef.current = false;
              });
          }
        }
      })
      .catch(() => {
        setOrgChecked(true);
        initialCheckDoneRef.current = true;
      })
      .finally(() => {
        checkingRef.current = false;
      });
  }, [session, sessionPending, skipGuard, navigate, pathname, refetchSession]);

  // Show spinner ONLY on first load (before initial check passes).
  // After initial check passes, subsequent re-checks happen silently
  // in the background — no spinner flash on SPA navigation.
  if (!skipGuard && !orgChecked && !initialCheckDoneRef.current) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-500" />
      </div>
    );
  }

  return <>{children}</>;
}
