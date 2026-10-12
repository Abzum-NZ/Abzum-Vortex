import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/** The HR Application source, bound to the shared registered block and theme catalogues. */
export const hrApplication: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
);
