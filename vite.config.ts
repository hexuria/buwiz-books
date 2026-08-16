import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { fileURLToPath, URL } from "url";
import { nitro } from "nitro/vite";

const enableDevtools = process.env.VITE_DEVTOOLS === "true";

const config = defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    hmr: {
      overlay: false,
    },
    headers: {
      // Prevent Safari from aggressively caching pre-bundled dep chunks.
      // Without this, Safari serves stale module URLs after Vite re-optimizes,
      // causing "504 Outdated Optimize Dep" / "Importing a module script failed".
      "Cache-Control": "no-store",
    },
  },
  plugins: [
    tailwindcss(),
    ...(enableDevtools ? [devtools()] : []),
    tanstackStart(),
    nitro({
      scanDirs: ["server"],
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    viteReact(),
  ],
  optimizeDeps: {
    entries: ["src/**/*.tsx", "src/**/*.ts", "index.html"],
    include: [
      "@better-auth/core",
      "nanostores",
      "defu",
      "@better-fetch/fetch",
      "@tanstack/router-core",
      "seroval",
    ],
  },
});

export default config;
