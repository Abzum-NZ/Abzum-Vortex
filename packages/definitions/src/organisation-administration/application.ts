import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/** Organisation Administration's authored Application source, loaded from JSON. */
export const organisationAdministrationApplication: ApplicationSourceDocument =
  loadApplicationSource(authoredSource, DEFAULT_SOURCE_APPLICATION_THEME_SELECTION);
