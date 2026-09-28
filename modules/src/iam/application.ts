import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/** IAM's current Application source; all placements use the shared registered block catalogue. */
export const iamApplication: ApplicationSourceDocumentV2 = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
);
