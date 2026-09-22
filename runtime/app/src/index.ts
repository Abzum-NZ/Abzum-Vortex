import "server-only";

import {
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
} from "./app-theme";

export {
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
} from "./app-theme";

export const AppService = Object.freeze({
  key: "app",
  boundary: "@vortex/app",
  resolveApplicationTheme,
  resolveApplicationThemeTokens,
});
