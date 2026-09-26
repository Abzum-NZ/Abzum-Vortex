import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";
import directorySource from "./sources/system-directory.directory.json";

/**
 * The System Directory Module: the shared read surface over the platform's own people, groups,
 * roles and organisation records. Each record type is a read-only system projection of one
 * registered protected view, so it declares `read` and no custom action and owns no permission
 * of its own; the registered reader applies the same existing platform read decision every other
 * projection of that view applies, and the application that binds a query names that platform
 * permission on its page. Declaring the same protected view in two modules is legal because the
 * protected read model registry is keyed by view alone, so this module adds a read surface rather
 * than a second copy of the data.
 *
 * Every change to a projected row still goes through the registered protected operation the
 * administration modules bind, and this module deliberately exposes no write path.
 */
export const systemDirectoryModule: ModuleSourceDocument = moduleSourceDocumentSchema.parse(
  directorySource,
);
