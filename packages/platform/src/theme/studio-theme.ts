import "server-only";
import {
  applicationThemeSchema,
  STUDIO_THEME_SELECTION,
} from "../definition/application-composition/theme";
import { DEFAULT_PLATFORM_THEME_RELEASE } from "./platform-theme-catalogue";

/**
 * Studio's own theme as a stored theme: the default platform release and Studio's selection. Its
 * tokens come from `resolveApplicationTheme`, like every other theme, so Studio's chrome follows
 * the catalogue and the organisation theme through the one resolution path.
 */
export const STUDIO_THEME = applicationThemeSchema.parse({
  base: {
    kind: "platform_theme",
    catalogueThemeId: DEFAULT_PLATFORM_THEME_RELEASE.catalogueThemeId,
    releaseVersion: DEFAULT_PLATFORM_THEME_RELEASE.releaseVersion,
  },
  selection: STUDIO_THEME_SELECTION,
});
