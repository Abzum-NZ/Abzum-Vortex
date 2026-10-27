import type { ApplicationThemeSelection } from "./theme";

/** Small authored and canonical values for the platform's current default theme selection. */
export const DEFAULT_APPLICATION_THEME_SELECTION = {
  style: "nova",
  baseColor: "neutral",
  theme: "neutral",
  chartColor: "neutral",
  radius: "default",
  menuColor: "default",
  menuAccent: "subtle",
  iconLibrary: "lucide",
  bodyFont: "inter",
  headingFont: "inherit",
} as ApplicationThemeSelection;
