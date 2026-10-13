import {
  sourceApplicationThemeSelectionSchema,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/**
 * CRM ships its own catalogue selection rather than the platform default, so an installed
 * application's theme is visibly its own: the rounded Maia style, the mauve base and theme colours,
 * violet charts, the large radius and the bold menu accent. Every option is an offered,
 * non-refused catalogue option, and the combination passes the platform contrast and focus checks
 * publication runs.
 */
const selection = sourceApplicationThemeSelectionSchema.parse({
  style: "maia",
  base_color: "mauve",
  theme: "mauve",
  chart_color: "violet",
  radius: "large",
  menu_color: "default",
  menu_accent: "bold",
  icon_library: "lucide",
  body_font: "inter",
  heading_font: "inherit",
});

/** CRM's current Application source; all placements use the shared registered block catalogue. */
export const application: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  selection,
);
