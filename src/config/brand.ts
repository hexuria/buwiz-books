/**
 * Brand configuration — single source of truth for white-label identity.
 *
 * Each client deployment is its own build + Cloud Run service (Model C), so brand
 * identity is per-deployment CONFIG, not a database row.
 *
 * Two runtimes, two sources:
 *   - `brand`       — client/UI values, baked at build time from `VITE_*` env.
 *                     Safe to import anywhere (bundled into the client).
 *   - `serverBrand` — server-only values (emails, PDFs) read from runtime
 *                     `process.env` on Cloud Run. `VITE_*` is stripped from the
 *                     server bundle, so these MUST come from plain env. The
 *                     getters defer `process.env` access to call time so this
 *                     module stays safe to import on the client.
 *
 * Defaults reproduce the stock "Buwiz Books" identity, so an unconfigured build
 * still renders correctly. Note that no deployment currently sets these — see
 * the branding block in `.env.example` — so the defaults below ARE production.
 */

const viteEnv = import.meta.env as Record<string, string | undefined>;

function pick(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

const DEFAULT_APP_NAME = "Buwiz Books";
const DEFAULT_PRIMARY = "#22c55e"; // matches --color-primary in styles.css
const DEFAULT_SUPPORT_EMAIL = "support@goldcoders.dev";

/** Client-side brand identity (baked at build time via VITE_* env). */
export const brand = {
  appName: pick(viteEnv.VITE_APP_NAME, DEFAULT_APP_NAME),
  /** Primary brand color — applied to `--color-primary` at runtime. */
  primary: pick(viteEnv.VITE_BRAND_PRIMARY, DEFAULT_PRIMARY),
  /** Accent color — applied to `--color-accent`. Defaults to primary. */
  accent: pick(viteEnv.VITE_BRAND_ACCENT, pick(viteEnv.VITE_BRAND_PRIMARY, DEFAULT_PRIMARY)),
  /** Logo URL (optional). Empty string means "use built-in wordmark". */
  logoUrl: pick(viteEnv.VITE_BRAND_LOGO_URL, ""),
  /** Favicon URL — defaults to the bundled SVG favicon. */
  faviconUrl: pick(viteEnv.VITE_BRAND_FAVICON_URL, "/favicon.svg"),
  supportEmail: pick(viteEnv.VITE_SUPPORT_EMAIL, DEFAULT_SUPPORT_EMAIL),
} as const;

/** True when a custom brand color was provided (worth overriding CSS vars). */
export const hasCustomBrandColor =
  brand.primary !== DEFAULT_PRIMARY || brand.accent !== DEFAULT_PRIMARY;

/**
 * First letter of the app name, for the built-in letter mark and as the avatar
 * fallback when an organization has no name yet.
 *
 * Every one of these sites used to be a hardcoded "D" left over from the Digits
 * era, which survived the rename because it is a bare glyph rather than a word.
 * Deriving it means a white-label build shows its own initial too.
 */
export const brandInitial = brand.appName.charAt(0).toUpperCase();

function serverEnv(key: string): string | undefined {
  return typeof process !== "undefined" ? process.env[key] : undefined;
}

/**
 * Server-only brand identity (emails, PDFs). Reads runtime `process.env` on
 * Cloud Run; falls back to the client `brand` values, then defaults. Never call
 * these getters from client code.
 */
export const serverBrand = {
  get appName(): string {
    return pick(serverEnv("APP_NAME"), brand.appName);
  },
  /** "From" header for transactional email, e.g. `Acme <noreply@acme.app>`. */
  get mailFrom(): string {
    return pick(serverEnv("MAIL_FROM"), `${this.appName} <${DEFAULT_SUPPORT_EMAIL}>`);
  },
  get supportEmail(): string {
    return pick(serverEnv("SUPPORT_EMAIL"), brand.supportEmail);
  },
};
