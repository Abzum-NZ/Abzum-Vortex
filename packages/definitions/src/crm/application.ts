import {
  sourceApplicationThemeSelectionSchema,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/**
 * CRM ships its own catalogue selection rather than the platform default, so an installed
 * application's theme is visibly its own: the square-cornered Sera style on a neutral base with
 * teal brand and chart colours, Inter for headings and body, Lucide icons, no radius and the
 * default solid menu with a subtle accent (shadcn create preset b5eFaVxg0). Every option is an
 * offered, non-refused catalogue option, and the combination passes the platform contrast and focus
 * checks publication runs.
 */
const selection = sourceApplicationThemeSelectionSchema.parse({
  style: "sera",
  base_color: "neutral",
  theme: "teal",
  chart_color: "teal",
  radius: "none",
  menu_color: "default",
  menu_accent: "subtle",
  icon_library: "lucide",
  body_font: "inter",
  heading_font: "inter",
});

/** CRM's current Application source; all placements use the shared registered block catalogue. */
export const application: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  selection,
);
