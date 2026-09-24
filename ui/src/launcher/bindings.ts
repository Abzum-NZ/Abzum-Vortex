import {
  applicationRootIdSchema,
  builderKeySchema,
  namespacedKeySchema,
  organizationIdSchema,
  safeHttpsUrlSchema,
  type ApplicationModuleQueryBinding,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { DisplayCellValue, DisplayRow, ProjectedDisplayValues } from "../display/projected-data";

const MAXIMUM_APPLICATIONS = 10_000;
const MAXIMUM_PAGE_KEYS = 10_000;
const MAXIMUM_APPLICATION_TEXT = 120;

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

const requireSafeHttpsAddress = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = safeHttpsUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

/** Trimmed text of the server's bounded application name and icon fields. */
const requireApplicationText = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 && text.length <= MAXIMUM_APPLICATION_TEXT ? text : fail(message, location);
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
 * `application_launcher` renderer consumes. Every row identity is the application's permanent
 * identity and only its name and icon cells are populated, so no page set or authority leaks out.
 * Unavailable reads are the caller's own state and never become launcher rows.
 */
export function permittedApplicationsToListValues(
  projection: Extract<PermittedApplicationsLauncherProjection, { kind: "available" }>,
): ProjectedDisplayValues {
  const rows: DisplayRow[] = projection.applications.map((application) => {
    const cells: Record<string, DisplayCellValue> = {
      name: Object.freeze({ kind: "text", text: application.name }),
      icon: Object.freeze({ kind: "text", text: application.icon }),
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
    const recordId =
      typeof row.recordId === "string" && row.recordId.trim().length > 0
        ? row.recordId
        : fail("A link tile requires a stable row identity", rowLocation);
    if (seen.has(recordId)) fail(`Duplicate link tile identity '${recordId}'`, rowLocation);
    seen.add(recordId);
    const address = requireSafeHttpsAddress(
      row.address,
      "A link tile requires a safe HTTPS address",
      rowLocation,
    );
    const label =
      typeof row.label === "string" && row.label.trim().length > 0
        ? row.label.trim()
        : fail("A link tile requires a label", rowLocation);
    const cells: Record<string, DisplayCellValue> = {
      label: Object.freeze({ kind: "text", text: label }),
      address: Object.freeze({ kind: "link", address, label }),
    };
    if (row.description !== undefined) {
      if (typeof row.description !== "string")
        fail("A link tile description must be text", rowLocation);
      else if (row.description.trim().length > 0)
        cells.description = Object.freeze({ kind: "text", text: row.description.trim() });
    }
    return Object.freeze({ recordId, cells: Object.freeze(cells) });
  });
  return Object.freeze({
    kind: "list",
    headingKey: "label",
    secondaryKey: "description",
    rows: Object.freeze(displayRows),
  });
}
