"use client";

import { useTheme } from "@/lib/theme/use-theme";
import { icons } from "./icons";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const Icon = theme === "dark" ? icons.Sun : icons.Moon;
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      className="touch-target inline-flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-surface-2 hover:text-text-1 desktop:h-9 desktop:w-9"
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
