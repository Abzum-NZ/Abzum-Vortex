import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { tenantAdministrationModule } from "./module";

/** Tenant Administration's authored Application source, loaded from JSON. */
export const tenantAdministrationApplication: ApplicationSourceDocument =
  loadApplicationSource(authoredSource, DEFAULT_SOURCE_APPLICATION_THEME_SELECTION, [
    tenantAdministrationModule,
  ]);
