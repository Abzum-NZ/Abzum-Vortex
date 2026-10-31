import type { ApplicationThemeSelection } from "./theme";

/**
 * The platform's current default theme selection: the owner's shadcn preset b7D4CRcLg. It is the
 * one definition every platform interface and every new Studio application starts from; a builder
 * changes only the application they are editing.
 */
export const DEFAULT_APPLICATION_THEME_SELECTION = {
  style: "sera",
  baseColor: "mist",
  theme: "mist",
  chartColor: "mist",
  radius: "none",
  menuColor: "default",
  menuAccent: "subtle",
  iconLibrary: "lucide",
  bodyFont: "inter",
  headingFont: "inter",
} as ApplicationThemeSelection;
