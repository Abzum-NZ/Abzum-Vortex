import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { appStoreModules } from "./module";

/**
 * The App Store: the one place to install an application in an organisation and to upgrade it to
 * its latest published version. Its catalogue is a read-only system projection, and installing and
 * upgrading are registered platform operations its flow calls.
 */
export const appStoreApplication: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  appStoreModules,
);
