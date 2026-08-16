/**
 * ThemeContext — Global theme management (light / dark / system)
 *
 * Stores preference in localStorage. Applies `dark` class to `<html>` for
 * Tailwind dark-mode, and a `data-theme` attribute for CSS variable overrides.
 */
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { brand, hasCustomBrandColor } from "../config/brand";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  /** User preference (light / dark / system) */
  mode: ThemeMode;
  /** Resolved theme after applying system preference */
  resolved: "light" | "dark";
  /** Cycle through: light → dark → system → light */
  cycle: () => void;
  /** Set a specific mode */
  setMode: (m: ThemeMode) => void;
}

const STORAGE_KEY = "buwiz-theme";

function getSystemPreference(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return getSystemPreference();
  return mode;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  resolved: "light",
  cycle: () => {},
  setMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start with "light" during SSR to match the server render.
  // The inline <script> in __root.tsx handles FOUC by setting the `dark` class
  // before React hydrates. We sync React state with localStorage in useEffect.
  const [mode, setModeState] = useState<ThemeMode>("light");

  // On mount, read the persisted preference from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    if (stored && (stored === "light" || stored === "dark" || stored === "system")) {
      setModeState(stored);
    }
  }, []);

  const resolved = resolveTheme(mode);

  // Apply per-deployment brand colors (white-label). Overrides the stock
  // --color-primary / --color-accent CSS vars when a custom brand color is set.
  useEffect(() => {
    if (!hasCustomBrandColor) return;
    const root = document.documentElement;
    root.style.setProperty("--color-primary", brand.primary);
    root.style.setProperty("--color-primary-hover", brand.primary);
    root.style.setProperty("--color-accent", brand.accent);
    root.style.setProperty("--color-accent-hover", brand.accent);
  }, []);

  // Apply `dark` class + `data-theme` to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    root.setAttribute("data-theme", resolved);
  }, [resolved]);

  // Listen for system preference changes when mode === "system"
  useEffect(() => {
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const root = document.documentElement;
      const newResolved = getSystemPreference();
      if (newResolved === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
      root.setAttribute("data-theme", newResolved);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem(STORAGE_KEY, m);
  }, []);

  const cycle = useCallback(() => {
    setMode(mode === "light" ? "dark" : mode === "dark" ? "system" : "light");
  }, [mode, setMode]);

  return (
    <ThemeContext.Provider value={{ mode, resolved, cycle, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
