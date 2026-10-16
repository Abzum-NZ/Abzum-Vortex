import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { organisationAdministrationModule } from "./module";
import { systemDirectoryModule } from "./system-directory";

/**
 * Organisation Administration's authored Application source, loaded from JSON. It owns the
 * System Directory Module every other Application that shows people uses.
 */
export const organisationAdministrationApplication: ApplicationSourceDocument =
  loadApplicationSource(authoredSource, DEFAULT_SOURCE_APPLICATION_THEME_SELECTION, [
    organisationAdministrationModule,
    systemDirectoryModule,
  ]);
