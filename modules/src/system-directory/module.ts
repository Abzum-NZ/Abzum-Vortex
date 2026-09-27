import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";
import directorySource from "./sources/system-directory.directory.json";

/**
 * The System Directory Module: the shared read surface over the platform's own people, groups,
 * roles and organisation records. Each record type is a read-only system projection of one
 * registered protected view, so it declares `read` and no custom action and owns no permission
 * of its own. The ordinary query path also requires a record-scoped read declaration for each
 * record type in the installed application's access plan; #1356 owns those bindings. The
 * registered reader still applies the existing platform read decision for that protected view.
 * Declaring the same protected view in two modules is legal because the protected read model
 * registry is keyed by view alone, so this module adds a read surface rather than a second copy
 * of the data.
 *
 * Application flow bindings surface the platform's protected operations as the only writes to
 * protected facts. Each operation rechecks current authority, the target revision and its
 * safeguard; this module deliberately exposes no write path.
 */
export const systemDirectoryModule: ModuleSourceDocument = moduleSourceDocumentSchema.parse(
  directorySource,
);
