import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";
import preferenceSource from "./sources/messages-preferences.preferences.json";

/** The reusable account-owned Messages Preferences Module source. */
export const messagesPreferenceModule: ModuleSourceDocument =
  moduleSourceDocumentSchema.parse(preferenceSource);
