import {
  applicationLauncherReadSchema,
  builderKeySchema,
  type ApplicationLauncherEntry,
  namespacedKeySchema,
  type DisplayRow,
  type DisplayScalarCell,
  type LauncherRowsPayload,
} from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const requireBuilderKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireNamespacedKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = namespacedKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const sameIdentity = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * The safe, presentation-only metadata of one permitted application: the fields of Identity/Access's
 * application-launcher read that a launcher tile may show. The tenant and
 * organisation identity of the read never cross this boundary.
 */
export type PermittedApplicationMetadata = ApplicationLauncherEntry;

/**
 * Launcher projection of the `ApplicationLauncherRead` returned by
 * `readPermittedApplicationsAtAddress` (packages/platform/src/definition/application-address.ts). The launcher block
 * supplies the organisation-address launcher when no default application resolves.
 */
export type PermittedApplicationsLauncherProjection =
  | Readonly<{
      kind: "available";
      defaultApplicationRootId: string | null;
      applications: readonly PermittedApplicationMetadata[];
    }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * Validates unknown input against the exact `ApplicationLauncherRead` schema the server builds it
 * with and projects it to launcher metadata. A malformed read, a duplicate identity or a default
 * outside the permitted set fails closed. The organisation identity, tenant and organisation short
 * names and the account's display name are validated, then dropped; a read that is not available
 * projects as unavailable.
 */
export function parsePermittedApplicationsLauncherProjection(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): PermittedApplicationsLauncherProjection {
  const read = applicationLauncherReadSchema.safeParse(value);
  if (!read.success)
    return fail(
      `Permitted applications are invalid: ${read.error.issues[0]?.message ?? "invalid"}`,
      location,
    );
  if (read.data.kind === "temporarily_unavailable")
    return Object.freeze({ kind: "temporarily_unavailable" });
  if (read.data.kind !== "available") return Object.freeze({ kind: "unavailable" });
  const { applications, defaultApplicationRootId } = read.data;
  const seen = new Set<string>();
  applications.forEach((application, index) => {
    const identity = application.applicationRootId.toLowerCase();
    if (seen.has(identity))
      fail(`Duplicate permitted application '${application.applicationRootId}'`, {
        ...location,
        propertyPath: [`applications[${index}]`],
      });
    seen.add(identity);
  });
  if (
    defaultApplicationRootId !== null &&
    !applications.some((application) =>
      sameIdentity(application.applicationRootId, defaultApplicationRootId),
    )
  )
    fail("The default application must be one of the permitted applications", location);
  return Object.freeze({
    kind: "available",
    defaultApplicationRootId,
    applications: Object.freeze(applications.map((application) => Object.freeze(application))),
  });
}

/**
 * Projects an available permitted-applications read into the closed `list` display values the
 * organisation-address `application_launcher` consumes. The row action identity is the
 * application's stable root identity, and only its name and icon cells are populated, so no page
 * set or authority leaks out. Unavailable reads are the caller's own state and never become
 * launcher rows.
 */
export function permittedApplicationsToListValues(
  projection: Extract<PermittedApplicationsLauncherProjection, { kind: "available" }>,
): LauncherRowsPayload {
  const rows: DisplayRow[] = projection.applications.map((application) => {
    const cells: Record<string, DisplayScalarCell> = {
      name: Object.freeze({ kind: "text", text: application.name }),
      icon: Object.freeze({ kind: "text", text: application.icon }),
    };
    return Object.freeze({ recordId: application.applicationRootId, cells: Object.freeze(cells) });
  });
  return Object.freeze({
    kind: "launcher_rows",
    headingKey: "name",
    secondaryKey: "icon",
    rows: Object.freeze(rows),
  });
}

/** A query row projected to launcher cell keys by its server-side module binding. */
export type ApplicationLauncherQueryRow = Readonly<{
  applicationKey: unknown;
  cells: Readonly<Record<string, DisplayScalarCell>>;
}>;

/**
 * Binds already-returned query rows to the application launcher and intersects them with the
 * protected permitted-application keys. Query rows supply layout and live display values only;
 * the protected read decides whether a row may be opened. The row action identity is the
 * application key, so the browser sends no projection record identity or permission evidence.
 */
export function applicationLauncherQueryRowsToListValues(
  rows: readonly ApplicationLauncherQueryRow[],
  permittedApplicationKeys: readonly string[],
  nameKey: string,
  iconKey: string,
  location: DefinitionRenderErrorLocation = {},
): LauncherRowsPayload {
  const headingKey = requireBuilderKey(
    nameKey,
    "An application launcher requires a name cell key",
    location,
  );
  const secondaryKey = requireBuilderKey(
    iconKey,
    "An application launcher requires an icon cell key",
    location,
  );
  const permitted = new Set(
    permittedApplicationKeys.map((key, index) =>
      requireNamespacedKey(key, "A permitted application key is invalid", {
        ...location,
        propertyPath: [`permittedApplicationKeys[${index}]`],
      }).toLowerCase(),
    ),
  );
  const seen = new Set<string>();
  const displayRows: DisplayRow[] = [];
  for (const [index, row] of rows.entries()) {
    const rowLocation = { ...location, propertyPath: [`rows[${index}]`] };
    const applicationKey = requireNamespacedKey(
      row.applicationKey,
      "A launcher query row requires an application key",
      rowLocation,
    );
    if (!permitted.has(applicationKey.toLowerCase())) continue;
    const identity = applicationKey.toLowerCase();
    if (seen.has(identity))
      fail(`Duplicate launcher application key '${applicationKey}'`, rowLocation);
    seen.add(identity);

    const projectedName = row.cells[headingKey];
    const name =
      projectedName?.kind === "text"
        ? projectedName
        : fail("A launcher query row requires its projected name cell", rowLocation);
    const projectedIcon = row.cells[secondaryKey];
    const icon =
      projectedIcon?.kind === "text"
        ? projectedIcon
        : fail("A launcher query row requires its projected icon cell", rowLocation);
    const cells: Record<string, DisplayScalarCell> = {
      [headingKey]: name,
      [secondaryKey]: icon,
    };
    const descriptionCell = row.cells.description;
    if (descriptionCell?.kind === "text") {
      cells.description = descriptionCell;
    }
    displayRows.push(
      Object.freeze({
        recordId: applicationKey,
        cells: Object.freeze(cells),
      }),
    );
  }
  return Object.freeze({
    kind: "launcher_rows",
    headingKey,
    secondaryKey,
    rows: Object.freeze(displayRows),
  });
}
