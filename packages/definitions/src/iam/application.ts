import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { iamModule } from "./module";

/** IAM's current Application source; all placements use the shared registered block catalogue. */
export const iamApplication: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  [iamModule],
);
