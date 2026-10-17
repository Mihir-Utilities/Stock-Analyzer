"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ThemeName } from "./tokens";

// Theme persistence (docs/06a section 9): localStorage now; `app_user.display_prefs` sync is
// added with the settings screen. The initial value is applied before paint by /theme-init.js.

export const THEME_STORAGE_KEY = "analyzer-theme";

export function isThemeName(value: unknown): value is ThemeName {
  return value === "dark" || value === "light";
}

export function resolveInitialTheme(stored: string | null, prefersDark: boolean): ThemeName {
  if (isThemeName(stored)) return stored;
  return prefersDark ? "dark" : "light";
}

function current(): ThemeName {
  const attr = document.documentElement.getAttribute("data-theme");
  return isThemeName(attr) ? attr : "dark";
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage may be blocked; the theme still applies for this page view.
  }
  listeners.forEach((l) => l());
}

export function useTheme(): {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  toggle: () => void;
} {
  const theme = useSyncExternalStore(subscribe, current, () => "dark" as ThemeName);
  const setTheme = useCallback((t: ThemeName) => applyTheme(t), []);
  const toggle = useCallback(() => applyTheme(current() === "dark" ? "light" : "dark"), []);
  return { theme, setTheme, toggle };
}
