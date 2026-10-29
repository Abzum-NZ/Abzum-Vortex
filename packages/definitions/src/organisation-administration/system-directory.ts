import directory from "./modules/system-directory.json";
import { connectionTypeDisplayOptions } from "./module";

/**
 * The System Directory Module, owned by Organisation Administration and used by every Application
 * that shows people, groups, roles or organisations: the shared read surface over the platform's
 * own people, groups, roles and organisation records. Each record type is a read-only system
 * projection of one registered protected view, so it declares `read` and no custom action. Its
 * active-person reference permission exposes only display labels under a saved condition; broader
 * directory reads remain application permissions. The ordinary query path requires a record-scoped
 * read declaration for each record type in the installed application's access plan. The registered
 * reader still applies the existing platform read decision for that protected view. Declaring the
 * same protected view in two modules is legal because the protected read model registry is keyed by
 * view alone, so this module adds a read surface rather than a second copy of the data.
 *
 * Application flow bindings surface the platform's protected operations as the only writes to
 * protected facts. Each operation rechecks current authority, the target revision and its
 * safeguard; this module deliberately exposes no write path.
 */
const systemDirectory = structuredClone(directory);
const connectionType = systemDirectory.record_types
  .find((record) => record.key === "connection_instance")
  ?.fields.find((field) => field.key === "connection_type_id");
if (connectionType === undefined) throw new Error("Connection type field is missing");
Object.assign(connectionType, {
  type: "choice",
  settings: { options: connectionTypeDisplayOptions, options_source: { kind: "fixed" } },
});
export const systemDirectoryModule: unknown = systemDirectory;
