import "server-only";

import type { JsonValue } from "../../catalogue/common";
import type { ApplicationLinkRow } from "../../catalogue/application-link";
import { isRecord } from "../../catalogue/runtime-primitives";
import type { BlockPropertyValueContract } from "../../definition/application-composition/block-property-values";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryRow,
} from "../../queries/protected-query-contracts";
import {
  readyPlacementData,
  logPlacementFailure,
  placementSettingsOf,
  queryRecordType,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { LauncherQueryRow, PlacementReadInput } from "./types";
import type { ApplicationSurfaceAccess } from "./types";
import { launcherRowsPayloadSchema } from "../display-payload-launcher";
import type { DisplayRow } from "../display-payload-rows";

const launcherCellKey = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  settingKey: string,
  fallback: string,
): string => {
  const value = settings[settingKey];
  return isRecord(value) && value.kind === "text" && typeof value.value === "string"
    ? value.value
    : fallback;
};

/** An optional declared text setting: present when the definition sets one. */
const optionalTextSetting = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  settingKey: string,
): string | undefined => {
  const value = settings[settingKey];
  return isRecord(value) && value.kind === "text" && typeof value.value === "string"
    ? value.value
    : undefined;
};

/**
 * A query-bound application launcher: one bounded keyset page of its query, intersected with the
 * applications the viewer may open. It projects only the key, name, icon and optional description
 * fields it displays, and the one internal link each tile offers the viewer: the Studio editor for
 * a builder, and the App Store's upgrade page for an installer while a newer release waits.
 */
export const readLauncher = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const { address, data } = read;
  const permittedApplicationKeys = read.permittedApplicationKeys;
  if (permittedApplicationKeys === undefined) {
    data[placementId] = read.permittedApplicationsUnavailable
      ? { status: "error" }
      : { status: "refused", reason: "not_permitted" };
    return;
  }
  const targetRecordType = queryRecordType(read.context, bound.query);
  if (targetRecordType === undefined) {
    logPlacementFailure(address, placementId, "launcher_query_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  const settings = placementSettingsOf(placement);
  const nameKey = launcherCellKey(settings, "name_key", "name");
  const iconKey = launcherCellKey(settings, "icon_key", "icon");
  const studioLinkLabel = optionalTextSetting(settings, "studio_link_label");
  const upgradeLinkLabel = optionalTextSetting(settings, "upgrade_link_label");
  const selectedFieldIds = new Set(bound.query.selectedFieldIds.map((id) => id.toLowerCase()));
  const displayFields = ["key", nameKey, iconKey].map((key) =>
    targetRecordType.fields.find((field) => field.key === key),
  );
  const requestedFieldIds = [...new Set(displayFields.flatMap((field) => field?.fieldId ?? []))];
  if (
    displayFields.some((field) => field === undefined) ||
    requestedFieldIds.some((fieldId) => !selectedFieldIds.has(String(fieldId).toLowerCase()))
  ) {
    logPlacementFailure(address, placementId, "launcher_query_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  // The launcher also shows the optional fixed `description` cell when the query selects it.
  const descriptionField = targetRecordType.fields.find((field) => field.key === "description");
  if (
    descriptionField !== undefined &&
    selectedFieldIds.has(String(descriptionField.fieldId).toLowerCase()) &&
    !requestedFieldIds.includes(descriptionField.fieldId)
  )
    requestedFieldIds.push(descriptionField.fieldId);
  const displayedFieldIds = new Set(requestedFieldIds.map((id) => id.toLowerCase()));
  // Link eligibility needs current status and platform origin, but neither is a display cell.
  if (studioLinkLabel !== undefined || upgradeLinkLabel !== undefined) {
    const decisionFields = ["status", "is_system_application"].map((key) =>
      targetRecordType.fields.find((field) => field.key === key),
    );
    if (
      decisionFields.some(
        (field) => field === undefined || !selectedFieldIds.has(field.fieldId.toLowerCase()),
      )
    ) {
      logPlacementFailure(address, placementId, "launcher_query_invalid");
      data[placementId] = { status: "error" };
      return;
    }
    for (const field of decisionFields)
      if (field !== undefined && !requestedFieldIds.includes(field.fieldId))
        requestedFieldIds.push(field.fieldId);
  }
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues,
    requestedFieldIds,
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: bound.query.pageSize,
  });
  if (!command.success) {
    logPlacementFailure(address, placementId, "launcher_query_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }

  const result = await read.services.queries.run(read.session, read.selection, command.data);
  if (result.kind === "temporarily_unavailable") {
    logPlacementFailure(address, placementId, "launcher_query_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  if (result.kind !== "available" || result.value.outcome !== "completed") {
    const failureCause =
      result.kind === "available" && result.value.outcome === "refused"
        ? result.value.reasonCode
        : result.kind;
    logPlacementFailure(address, placementId, "launcher_query_refused", failureCause);
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const queryRows: ProtectedQueryRow[] = result.value.rows;

  const fieldKeys = new Map(
    targetRecordType.fields.map(
      (field) => [String(field.fieldId).toLowerCase(), field.key] as const,
    ),
  );
  const launcherRows: LauncherQueryRow[] = queryRows.map((row) => {
    const cells: Record<string, { kind: "text"; text: string }> = {};
    for (const [fieldId, value] of Object.entries(row.values)) {
      if (!displayedFieldIds.has(fieldId.toLowerCase())) continue;
      const fieldKey = fieldKeys.get(fieldId.toLowerCase());
      if (fieldKey !== undefined && typeof value === "string")
        cells[fieldKey] = { kind: "text", text: value };
    }
    return { applicationKey: cells.key?.text, cells };
  });
  const payload = launcherRowsPayloadSchema.parse(
    read.services.launcherValues(launcherRows, permittedApplicationKeys, nameKey, iconKey),
  );
  const surfaces = read.applicationSurfaces;
  const linksDeclared = studioLinkLabel !== undefined || upgradeLinkLabel !== undefined;
  const applications =
    surfaces === undefined || !linksDeclared
      ? undefined
      : applicationFacts(rowFieldValues(queryRows, targetRecordType), targetRecordType);
  const linkedRows =
    surfaces === undefined || applications === undefined
      ? undefined
      : withApplicationLinks(payload.rows, applications, surfaces, {
          ...(studioLinkLabel === undefined ? {} : { studio: studioLinkLabel }),
          ...(upgradeLinkLabel === undefined ? {} : { upgrade: upgradeLinkLabel }),
        });
  data[placementId] = readyPlacementData(
    read.address,
    placementId,
    launcherRowsPayloadSchema,
    linkedRows === undefined ? payload : { ...payload, rows: linkedRows },
  );
};

/** The values of every query row by lower-cased field key, for the fields a link is decided on. */
const rowFieldValues = (
  rows: readonly ProtectedQueryRow[],
  recordType: NonNullable<ReturnType<typeof queryRecordType>>,
): readonly Readonly<Record<string, unknown>>[] => {
  const keyByFieldId = new Map(
    recordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field.key] as const),
  );
  return rows.map((row) => {
    const values: Record<string, unknown> = { recordId: row.recordId };
    for (const [fieldId, value] of Object.entries(row.values)) {
      const fieldKey = keyByFieldId.get(fieldId.toLowerCase());
      if (fieldKey !== undefined) values[fieldKey] = value;
    }
    return Object.freeze(values);
  });
};

/** The application a launcher row names, when the read projected enough of it to decide links. */
type LauncherApplication = Readonly<{
  applicationKey: string;
  application: ApplicationLinkRow;
}>;

const applicationFacts = (
  rows: readonly Readonly<Record<string, unknown>>[],
  recordType: NonNullable<ReturnType<typeof queryRecordType>>,
): readonly LauncherApplication[] => {
  const hasSystemField = recordType.fields.some((field) => field.key === "is_system_application");
  return rows.flatMap((values) => {
    const key = values.key;
    const recordId = values.recordId;
    if (typeof key !== "string" || key.length === 0 || typeof recordId !== "string") return [];
    const status = values.status;
    return [
      {
        applicationKey: key,
        application: {
          applicationRootId: recordId,
          key,
          status: typeof status === "string" ? status : null,
          isSystemApplication: hasSystemField && values.is_system_application === true,
        },
      },
    ];
  });
};

/**
 * Each tile's links as the viewer is offered them: the Studio editor for a builder, and the App
 * Store's upgrade page for an installer while the organisation runs an older version. A tile the
 * person is not offered a link on carries none, so no component decides who sees what.
 */
const withApplicationLinks = (
  rows: readonly DisplayRow[],
  applications: readonly LauncherApplication[],
  surfaces: ApplicationSurfaceAccess,
  labels: Readonly<{ studio?: string; upgrade?: string }>,
): DisplayRow[] => {
  const byKey = new Map(applications.map((entry) => [entry.applicationKey.toLowerCase(), entry]));
  return rows.map((row) => {
    const entry = byKey.get(row.recordId.toLowerCase());
    if (entry === undefined) return row;
    const links: { label: string; href: string }[] = [];
    if (labels.studio !== undefined) {
      const href = surfaces.link("studio_editor", entry.application);
      if (href !== undefined) links.push({ label: labels.studio, href });
    }
    if (labels.upgrade !== undefined && entry.application.status === "update_available") {
      const href = surfaces.link("app_store_upgrade", entry.application);
      if (href !== undefined) links.push({ label: labels.upgrade, href });
    }
    return links.length === 0 ? row : { ...row, links: Object.freeze(links) };
  });
};
