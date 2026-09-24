import {
  applicationRootIdSchema,
  builderKeySchema,
  safeHttpsUrlSchema,
  type ApplicationModuleQueryBinding,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { DisplayCellValue, DisplayRow, ProjectedDisplayValues } from "../display/projected-data";

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
};

const requireNonEmptyString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  if (typeof value !== "string" || value.trim().length === 0) return fail(message, location);
  return value;
};

const requireBuilderKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

/**
 * The safe, presentation-only metadata of one permitted application. It mirrors only the fields of
 * Identity/Access's permitted-applications read that a launcher tile may show: no page sets, roles,
 * permissions or tenant/organisation identifiers cross this boundary.
 */
export type PermittedApplicationMetadata = Readonly<{
  applicationRootId: string;
  key: string;
  name: string;
  iconKey: string;
  homePageKey: string;
}>;

/**
 * Browser-safe mirror of the permitted-applications result shape returned by
 * `readPermittedApplicationsAtAddress` (runtime/app/src/application-address.ts). The launcher block
 * binds to this projection; it is the only launcher input that names applications.
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
    ["applicationRootId", "key", "name", "iconKey", "homePageKey"],
    location,
  );
  const applicationRootId = applicationRootIdSchema.safeParse(record.applicationRootId);
  if (!applicationRootId.success)
    fail("A permitted application requires a permanent application identity", location);
  return Object.freeze({
    applicationRootId: applicationRootId.data,
    key: requireBuilderKey(record.key, "A permitted application requires a stable key", location),
    name: requireNonEmptyString(record.name, "A permitted application requires a name", location),
    iconKey: requireBuilderKey(record.iconKey, "A permitted application requires an icon key", location),
    homePageKey: requireBuilderKey(
      record.homePageKey,
      "A permitted application requires a home page key",
      location,
    ),
  });
};

/**
 * Validates unknown permitted-applications input into its closed launcher projection. An unknown
 * status, a malformed application or a duplicate identity fails closed.
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
    ["kind", "defaultApplicationRootId", "applications"],
    location,
  );
  const defaultApplicationRootId =
    record.defaultApplicationRootId === null
      ? null
      : requireNonEmptyString(
          record.defaultApplicationRootId,
          "A default application identity must be a string or null",
          location,
        );
  const applicationsInput = record.applications;
  if (!Array.isArray(applicationsInput))
    fail("Permitted applications must be an array", location);
  const seen = new Set<string>();
  const applications = applicationsInput.map((entry, index) => {
    const entryLocation = { ...location, propertyPath: [`applications[${index}]`] };
    const application = parseApplicationMetadata(entry, entryLocation);
    if (seen.has(application.applicationRootId))
      fail(`Duplicate permitted application '${application.applicationRootId}'`, entryLocation);
    seen.add(application.applicationRootId);
    return application;
  });
  if (
    defaultApplicationRootId !== null &&
    !applications.some(
      (application) =>
        application.applicationRootId.toLowerCase() === defaultApplicationRootId.toLowerCase(),
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
 * Projects a validated permitted-applications read into the closed `list` display values the
 * `application_launcher` renderer consumes. Every row identity is the application's permanent
 * identity; only the name and icon cells are populated, so no page set or authority leaks out.
 */
export function permittedApplicationsToListValues(
  projection: PermittedApplicationsLauncherProjection,
): ProjectedDisplayValues {
  if (projection.kind !== "available")
    return Object.freeze({ kind: "list", headingKey: "name", secondaryKey: "icon", rows: Object.freeze([]) });
  const rows: DisplayRow[] = projection.applications.map((application) => {
    const cells: Record<string, DisplayCellValue> = {
      name: Object.freeze({ kind: "text", text: application.name }),
      icon: Object.freeze({ kind: "text", text: application.iconKey }),
    };
    return Object.freeze({ recordId: application.applicationRootId, cells: Object.freeze(cells) });
  });
  return Object.freeze({
    kind: "list",
    headingKey: "name",
    secondaryKey: "icon",
    rows: Object.freeze(rows),
  });
}

/**
 * The exact query binding a `link_tiles` block resolves when live query execution arrives (#584).
 * It names one published Module release and query identity and never a database target.
 */
export type LinkTilesQueryBinding = Readonly<{ query: ApplicationModuleQueryBinding }>;

/** One query-projected link tile: safe display metadata plus an already-validated HTTPS address. */
export type LinkTileRow = Readonly<{
  recordId: string;
  label: string;
  address: string;
  description?: string;
}>;

/**
 * Projects already-returned query rows into the closed `list` display values `link_tiles`
 * consumes. Addresses are re-validated as safe HTTPS addresses; anything else fails closed. This
 * function never executes the bound query; it only presents rows the caller already has.
 */
export function linkTilesToListValues(
  rows: readonly LinkTileRow[],
  location: DefinitionRenderErrorLocation = {},
): ProjectedDisplayValues {
  const seen = new Set<string>();
  const displayRows: DisplayRow[] = rows.map((row, index) => {
    const rowLocation = { ...location, propertyPath: [`rows[${index}]`] };
    const recordId = requireNonEmptyString(
      row.recordId,
      "A link tile requires a stable row identity",
      rowLocation,
    );
    if (seen.has(recordId)) fail(`Duplicate link tile identity '${recordId}'`, rowLocation);
    seen.add(recordId);
    const address = safeHttpsUrlSchema.safeParse(row.address);
    if (!address.success)
      fail("A link tile requires a safe HTTPS address", rowLocation);
    const label = requireNonEmptyString(row.label, "A link tile requires a label", rowLocation);
    const cells: Record<string, DisplayCellValue> = {
      label: Object.freeze({ kind: "text", text: label }),
      address: Object.freeze({ kind: "link", address: address.data, label }),
    };
    if (row.description !== undefined && row.description.trim().length > 0)
      cells.description = Object.freeze({ kind: "text", text: row.description });
    return Object.freeze({ recordId, cells: Object.freeze(cells) });
  });
  return Object.freeze({
    kind: "list",
    headingKey: "label",
    secondaryKey: "description",
    rows: Object.freeze(displayRows),
  });
}
