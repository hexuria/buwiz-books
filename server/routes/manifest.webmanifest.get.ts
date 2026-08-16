/**
 * Dynamic web app manifest — reflects the per-client white-label brand instead of a
 * hardcoded name. Replaces the static public/manifest.json, which pinned a fixed
 * app name and so could not follow a per-client build.
 */
import { defineEventHandler, setHeader } from "h3";
import { serverBrand } from "../../src/config/brand";

export default defineEventHandler((event) => {
  setHeader(event, "Content-Type", "application/manifest+json");
  const appName = serverBrand.appName;
  return {
    short_name: appName,
    name: `${appName} — Accounting Platform`,
    icons: [
      { src: "favicon.ico", sizes: "48x48 32x32 16x16", type: "image/x-icon" },
      { src: "logo192.png", type: "image/png", sizes: "192x192" },
      { src: "logo512.png", type: "image/png", sizes: "512x512", purpose: "any maskable" },
    ],
    start_url: "/",
    display: "standalone",
    theme_color: "#6366f1",
    background_color: "#0f0f14",
  };
});
