import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/** Tenant Administration's authored Application source, loaded from JSON. */
export const tenantAdministrationApplication: ApplicationSourceDocumentV2 =
  loadApplicationSource(authoredSource, DEFAULT_SOURCE_APPLICATION_THEME_SELECTION);
