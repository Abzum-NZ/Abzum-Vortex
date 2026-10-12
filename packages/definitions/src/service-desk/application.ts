import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/** Service Desk's current Application source using the shared registered block catalogue. */
export const application: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
);
