import type { CSSProperties } from "react";

/** The viewer's appearance choice. System follows the browser colour-scheme preference. */
export type ThemeMode = "light" | "dark" | "system";

const COLOR_SCHEME: Readonly<Record<ThemeMode, string>> = {
  light: "light",
  dark: "dark",
  system: "light dark",
};

/** The cookie that holds the viewer's appearance choice, read by the server render. */
export const APPEARANCE_COOKIE = "vortex-appearance";

export function parseThemeMode(value: string | undefined): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

export type AppearanceRootProps = Readonly<{
  style: CSSProperties;
  "data-vortex-theme-mode": ThemeMode;
}>;

/** The document owns appearance; application surfaces inherit it. */
export function createAppearanceRootProps(mode: ThemeMode): AppearanceRootProps {
  return { style: { colorScheme: COLOR_SCHEME[mode] }, "data-vortex-theme-mode": mode };
}
