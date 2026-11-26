import { Compass, Moon, Sun } from "lucide-react";
import { THEME_OPTIONS, type ThemeId } from "../lib/theme";

const THEME_ICONS: Record<ThemeId, typeof Compass> = {
  navy: Compass,
  dark: Moon,
  light: Sun,
};

export function ThemeSwitcher({
  theme,
  onChange,
  variant = "sidebar",
}: {
  theme: ThemeId;
  onChange: (next: ThemeId) => void;
  variant?: "sidebar" | "surface";
}) {
  return (
    <div
      className={`theme-switcher theme-switcher-${variant}`}
      role="group"
      aria-label="Color theme"
    >
      {THEME_OPTIONS.map((opt) => {
        const Icon = THEME_ICONS[opt.id];
        const active = theme === opt.id;
        return (
          <button
            key={opt.id}
            id={`theme-btn-${variant}-${opt.id}`}
            type="button"
            className={`theme-chip ${active ? "active" : ""}`}
            aria-pressed={active}
            title={opt.description}
            onClick={() => onChange(opt.id)}
          >
            <Icon size={12} aria-hidden="true" />
            <span>{opt.shortLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
