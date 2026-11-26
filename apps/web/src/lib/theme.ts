import { useCallback, useEffect, useState } from "react";

export type ThemeId = "navy" | "dark" | "light";

export interface ThemeOption {
  id: ThemeId;
  label: string;
  shortLabel: string;
  themeColor: string;
  description: string;
}

export const DEFAULT_THEME: ThemeId = "navy";
export const THEME_STORAGE_KEY = "supermarket_os_theme";

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "navy",
    label: "Blue-Navy",
    shortLabel: "Navy",
    themeColor: "#080e1a",
    description: "Deep midnight blue-navy command interface",
  },
  {
    id: "dark",
    label: "Dark",
    shortLabel: "Dark",
    themeColor: "#0c0e12",
    description: "Carbon obsidian dark interface with emerald accents",
  },
  {
    id: "light",
    label: "Light",
    shortLabel: "Light",
    themeColor: "#f7f5f0",
    description: "Warm editorial light interface",
  },
] as const;

export function isThemeId(value: unknown): value is ThemeId {
  return value === "navy" || value === "dark" || value === "light";
}

export function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(saved)) return saved;
  } catch {
    // Ignore storage access failures in restricted contexts
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const opt = THEME_OPTIONS.find((item) => item.id === theme);
  if (meta && opt) {
    meta.content = opt.themeColor;
  }
}

export function persistTheme(theme: ThemeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage quota / privacy-mode errors
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    applyTheme(next);
    persistTheme(next);
  }, []);

  return { theme, setTheme };
}
