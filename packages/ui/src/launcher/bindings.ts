import {
  applicationRootIdSchema,
  builderKeySchema,
  namespacedKeySchema,
  organizationIdSchema,
  isRecord,
} from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { DisplayCellValue, DisplayRow, LauncherRowsPayload } from "../display/projected-data";

const MAXIMUM_APPLICATIONS = 10_000;
const MAXIMUM_PAGE_KEYS = 10_000;
const MAXIMUM_APPLICATION_TEXT = 120;

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => (isRecord(value) ? value : fail(message, location));

const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unexpected property '${key}'`, location);
  for (const key of allowed)
    if (!Object.hasOwn(value, key)) fail(`Missing property '${key}'`, location);
};

const requireArray = (
  value: unknown,
  maximum: number,
  message: string,
  location: DefinitionRenderErrorLocation,
): readonly unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail(message, location);

const requireApplicationRootId = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = applicationRootIdSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
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

const requireOrganizationId = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = organizationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

/** Trimmed text of the server's bounded application name and icon fields. */
const requireApplicationText = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 && text.length <= MAXIMUM_APPLICATION_TEXT
    ? text
    : fail(message, location);
};

const sameIdentity = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * The safe, presentation-only metadata of one permitted application: the fields of Identity/Access's
 * permitted-applications read that a launcher tile may show. Its page set and the tenant and
 * organisation identity of the read never cross this boundary.
 */
export type PermittedApplicationMetadata = Readonly<{
  applicationRootId: string;
  key: string;
  name: string;
  icon: string;
  homePageKey: string;
}>;

/**
 * Launcher projection of the `PermittedApplicationsRead` returned by
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

const parseApplicationMetadata = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): PermittedApplicationMetadata => {
  const record = requireRecord(value, "A permitted application must be an object", location);
  requireExactKeys(
    record,
    ["applicationRootId", "key", "name", "icon", "homePageKey", "pageKeys"],
    location,
  );
  const pageKeys = requireArray(
    record.pageKeys,
    MAXIMUM_PAGE_KEYS,
    "A permitted application requires its permitted page keys",
    location,
  );
  if (pageKeys.length === 0)
    fail("A permitted application requires at least one permitted page", location);
  for (const pageKey of pageKeys)
    requireBuilderKey(pageKey, "A permitted page key is invalid", location);
  return Object.freeze({
    applicationRootId: requireApplicationRootId(
      record.applicationRootId,
      "A permitted application requires a permanent application identity",
      location,
    ),
    key: requireNamespacedKey(
      record.key,
      "A permitted application requires a namespaced key",
      location,
    ),
    name: requireApplicationText(record.name, "A permitted application requires a name", location),
    icon: requireApplicationText(record.icon, "A permitted application requires an icon", location),
    homePageKey: requireBuilderKey(
      record.homePageKey,
      "A permitted application requires a home page key",
      location,
    ),
  });
};

/**
 * Validates unknown input against the exact `PermittedApplicationsRead` shape and projects it to
 * launcher metadata. An unknown status, a missing or unexpected field, a malformed application, a
 * duplicate identity or a default outside the permitted set fails closed. The organisation identity,
 * tenant and organisation short names and page sets are validated, then dropped.
 */
export function parsePermittedApplicationsLauncherProjection(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): PermittedApplicationsLauncherProjection {
  const record = requireRecord(value, "Permitted applications must be an object", location);
  if (record.kind === "unavailable") {
    requireExactKeys(record, ["kind"], location);
    return Object.freeze({ kind: "unavailable" });
  }
  if (record.kind === "temporarily_unavailable") {
    requireExactKeys(record, ["kind"], location);
    return Object.freeze({ kind: "temporarily_unavailable" });
  }
  if (record.kind !== "available")
    return fail(`Unknown permitted-applications status '${String(record.kind)}'`, location);
  requireExactKeys(
    record,
    [
      "kind",
      "organizationId",
      "tenantShortName",
      "organizationShortName",
      "defaultApplicationRootId",
      "applications",
    ],
    location,
  );
  requireOrganizationId(record.organizationId, "An organisation identity is invalid", location);
  requireBuilderKey(record.tenantShortName, "A tenant short name is invalid", location);
  requireBuilderKey(
    record.organizationShortName,
    "An organisation short name is invalid",
    location,
  );
  const defaultApplicationRootId: string | null =
    record.defaultApplicationRootId === null
      ? null
      : requireApplicationRootId(
          record.defaultApplicationRootId,
          "A default application identity must be a permanent identity or null",
          location,
        );
  const entries = requireArray(
    record.applications,
    MAXIMUM_APPLICATIONS,
    "Permitted applications must be a bounded array",
    location,
  );
  const seen = new Set<string>();
  const applications = entries.map((entry, index) => {
    const entryLocation = { ...location, propertyPath: [`applications[${index}]`] };
    const application = parseApplicationMetadata(entry, entryLocation);
    const identity = application.applicationRootId.toLowerCase();
    if (seen.has(identity))
      fail(`Duplicate permitted application '${application.applicationRootId}'`, entryLocation);
    seen.add(identity);
    return application;
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
    applications: Object.freeze(applications),
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
    const cells: Record<string, DisplayCellValue> = {
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
  cells: Readonly<Record<string, DisplayCellValue>>;
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
    const cells: Record<string, DisplayCellValue> = {
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
