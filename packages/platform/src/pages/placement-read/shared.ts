import "server-only";

import {
  isRecord,
  readRecordsTableContract,
  sameId,
  tableColumnLabel,
  type BlockPropertyValueContract,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type PageDefinition,
} from "../../schema";
import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  type InstalledRuntimeContext,
} from "../../definition/index";
import type { ProtectedQueryRow } from "../../queries/index";
import {
  collectRecordLinks,
  type LinkFieldType,
  type RecordLinkResolver,
  type TableFieldColumn,
} from "../component-data-projection";
import type { BoardPlacementFailureCause } from "../board-query";
import type { RecordsTableFilterTarget } from "../records-table-query";
import type { RecordsTableInlineEditor } from "../records-table-features";

export type PlacementModule = InstalledRuntimeContext["releaseSet"]["modules"][number];
export type PlacementQuery = PlacementModule["content"]["queries"][number];
export type PlacementField = PlacementModule["content"]["recordTypes"][number]["fields"][number];
export type AddressParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

/** One placement's projected state; each block's own registration parses it in the browser. */
export type PageDataState = Readonly<Record<string, unknown>>;

/**
 * One placed item of a projected page: the item, its Vortex metadata (`props.vortex`) and its typed
 * settings, read by its block release's declaration.
 */
export type PlacementReadEntry = Readonly<{
  placementId: string;
  item: Record<string, unknown>;
  vortex: Record<string, unknown>;
  settings: Record<string, unknown>;
  formId?: string;
}>;

/** The resolved record type the page's own address names the subject of. */
export type PageSubjectType = Extract<
  NonNullable<
    Extract<PageDefinition, { type: "detail" | "public" | "form" | "guided_form" }>["recordType"]
  >,
  { state: "resolved" }
>;

/** Where a placement read is logged from: the application and the page, never a value. */
export type PlacementLogPlace = Readonly<{
  application: Readonly<{ key: string }>;
  pageKey: string;
}>;

export type PlacementFailureReason =
  | "query_not_bound"
  | "query_binding_refused"
  | "query_binding_withheld"
  | "summary_query_threw"
  | "subject_unavailable"
  | "detail_record_type_unavailable"
  | "detail_command_invalid"
  | "detail_query_unavailable"
  | "detail_query_refused"
  | "launcher_query_invalid"
  | "launcher_query_unavailable"
  | "launcher_query_refused"
  | "calendar_settings_invalid"
  | "calendar_range_unsupported"
  | "calendar_time_zone_unavailable"
  | "table_time_zone_unavailable"
  | "board_state_unsupported"
  | "board_filter_refused"
  | "table_tree_off"
  | "table_grouping_invalid"
  | "table_grouping_refused"
  | "table_tree_invalid"
  | "calendar_query_invalid"
  | "calendar_query_unavailable"
  | "calendar_query_refused"
  | "calendar_arrangement_refused"
  | "summary_query_invalid"
  | "summary_query_unavailable"
  | "summary_query_refused"
  | "summary_dataset_limit_exceeded"
  | "summary_value_out_of_range"
  | "summary_result_invalid"
  | "chart_settings_invalid"
  | "chart_group_invalid"
  | "chart_measure_invalid"
  | "placement_read_failed"
  | "choice_settings_invalid"
  | "link_initial_value_invalid"
  | "link_initial_value_unavailable"
  | "link_titles_unavailable"
  | "edit_field_unprojected"
  | "create_field_default_unprojected"
  | BoardPlacementFailureCause
  | "board_payload_invalid"
  | "table_state_malformed"
  | "table_formatting_time_zone_unavailable"
  | "table_columns_withheld";

/**
 * Logs one data placement that could not be loaded, server side only: the application, page and
 * placement identities that are already in the address, and a fixed reason code. Never a message,
 * value, row, query input or secret, so the log names the failing step without leaking data.
 */
export const logPlacementFailure = (
  address: PlacementLogPlace,
  placementId: string,
  reason: PlacementFailureReason,
  detail?: string,
): void => {
  console.error(
    `[page] data placement not loaded: application=${address.application.key} page=${address.pageKey} placement=${placementId} reason=${reason}${detail === undefined ? "" : ` cause=${detail}`}`,
  );
};

export const firstParameter = (
  value: string | readonly string[] | undefined,
): string | undefined => (typeof value === "string" ? value : value?.[0]);

/** Whether a placement is of the given block release's block, at any of its releases. */
export const placementBlockIs = (
  placement: Pick<PlacementReadEntry, "vortex">,
  release: Readonly<{ blockId: string }>,
): boolean => {
  const block = placement.vortex.block;
  return (
    isRecord(block) && typeof block.blockId === "string" && sameId(block.blockId, release.blockId)
  );
};

export const placementReleaseVersion = (placement: Pick<PlacementReadEntry, "vortex">): string => {
  const block = placement.vortex.block;
  return isRecord(block) && typeof block.releaseVersion === "string" ? block.releaseVersion : "";
};

export const isApplicationLauncherPlacement = (
  placement: Pick<PlacementReadEntry, "vortex">,
): boolean => placementBlockIs(placement, APPLICATION_LAUNCHER_BLOCK_RELEASE);

/** Whether a Records table placement shows its records as a board (its Board feature is on). */
export const isBoardPlacement = (placement: Pick<PlacementReadEntry, "settings">): boolean =>
  readRecordsTableContract(placementSettingsOf(placement))?.features.board.enabled === true;

/** A placement's use: available, unavailable by its operation, or a malformed availability. */
export const projectedUseAvailability = ({
  vortex,
}: Pick<PlacementReadEntry, "vortex">): "available" | "unavailable" | "invalid" => {
  const hasAvailability = Object.hasOwn(vortex, "availability");
  const hasReason = Object.hasOwn(vortex, "unavailableReason");
  if (!hasAvailability && !hasReason) return "available";
  if (
    hasAvailability &&
    hasReason &&
    vortex.availability === "unavailable" &&
    vortex.unavailableReason === "operation_unavailable"
  )
    return "unavailable";
  return "invalid";
};

export const placementSettingsOf = (
  placement: Pick<PlacementReadEntry, "settings">,
): Readonly<Record<string, BlockPropertyValueContract>> =>
  placement.settings as Readonly<Record<string, BlockPropertyValueContract>>;

export const findModuleQuery = (
  context: InstalledRuntimeContext,
  queryId: string,
): Readonly<{ module: PlacementModule; query: PlacementQuery }> | undefined => {
  for (const module of context.releaseSet.modules) {
    const query = module.content.queries.find((candidate) => sameId(candidate.queryId, queryId));
    if (query !== undefined) return { module, query };
  }
  return undefined;
};

export const resolvedQueryRecordTypeId = (
  context: InstalledRuntimeContext,
  queryId: string,
): string | undefined => {
  const recordType = findModuleQuery(context, queryId)?.query.recordType;
  return recordType?.state === "resolved" ? String(recordType.recordTypeId) : undefined;
};

/** The installed record type a query reads, and its module. */
export const queryRecordType = (
  context: InstalledRuntimeContext,
  query: PlacementQuery,
): PlacementModule["content"]["recordTypes"][number] | undefined => {
  const reference = query.recordType;
  if (reference.state !== "resolved") return undefined;
  return context.releaseSet.modules
    .find((module) => sameId(String(module.rootId), String(reference.moduleRootId)))
    ?.content.recordTypes.find((recordType) =>
      sameId(String(recordType.recordTypeId), String(reference.recordTypeId)),
    );
};

/** The labels of the linked records the rows carry, read once; undefined when none or unreadable. */
export const readRecordLinks = async (
  resolve: RecordLinkResolver,
  rows: readonly ProtectedQueryRow[],
): ReturnType<RecordLinkResolver> => {
  const links = collectRecordLinks(rows);
  return links.length === 0 ? undefined : resolve(links);
};

export const fieldLabelsOf = (module: PlacementModule): Record<string, string> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field.label] as const),
    ),
  );

export const fieldDateTypesOf = (module: PlacementModule): Record<string, "date" | "date_time"> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) => {
        const valueType =
          field.type === "calculation" || field.type === "total"
            ? field.settings.resultType
            : field.type;
        return valueType === "date" || valueType === "date_time"
          ? [[String(field.fieldId).toLowerCase(), valueType] as const]
          : [];
      }),
    ),
  );

export const fieldLinkTypesOf = (module: PlacementModule): Record<string, LinkFieldType> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) =>
        field.type === "web_address" ||
        field.type === "email_address" ||
        field.type === "phone_number"
          ? [[String(field.fieldId).toLowerCase(), field.type] as const]
          : [],
      ),
    ),
  );

/**
 * The declared columns of every table field, in definition order, with the heading the form shows
 * and, for a choice column, its options, so a record detail shows a table field's stored rows.
 */
export const fieldTableColumnsOf = (
  module: PlacementModule,
): Record<string, readonly TableFieldColumn[]> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) =>
        field.type !== "table"
          ? []
          : [
              [
                String(field.fieldId).toLowerCase(),
                field.settings.columns.map((column): TableFieldColumn => ({
                  key: column.key,
                  label: tableColumnLabel(column.key),
                  type: column.type,
                  ...(column.type === "choice"
                    ? {
                        options: column.settings.options.map((option) => ({
                          value: option.value,
                          label: option.label,
                        })),
                      }
                    : {}),
                })),
              ] as const,
            ],
      ),
    ),
  );

/**
 * The label of every declared option of each choice field, in definition order. These labels only
 * resolve a STORED value into text on the server; the permission that gates choosing an option is
 * enforced where options are offered (the field settings), never when a held value is displayed.
 */
export const fieldChoiceLabelsOf = (
  module: PlacementModule,
): Record<string, readonly Readonly<{ value: string; label: string }>[]> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) =>
        field.type !== "several_choices" && field.type !== "choice"
          ? []
          : [
              [
                String(field.fieldId).toLowerCase(),
                field.settings.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
              ] as const,
            ],
      ),
    ),
  );

/**
 * What a Records table filter may know of every field of one module: its canonical type and name,
 * a choice field's options, a fixed money currency and a link field's resolved target record type.
 * The server builds each filter condition from these, never from what the browser sends.
 */
export const fieldFilterTargetsOf = (
  module: PlacementModule,
): Record<string, RecordsTableFilterTarget> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.map((field): [string, RecordsTableFilterTarget] => {
        const target: RecordsTableFilterTarget = { type: field.type, label: field.label };
        switch (field.type) {
          case "choice":
          case "several_choices":
            return [
              String(field.fieldId).toLowerCase(),
              {
                ...target,
                options: field.settings.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
              },
            ];
          case "money":
            return [
              String(field.fieldId).toLowerCase(),
              field.settings.currency === undefined
                ? target
                : { ...target, currency: field.settings.currency },
            ];
          case "link":
            return [
              String(field.fieldId).toLowerCase(),
              field.settings.target.state === "resolved"
                ? { ...target, recordTypeId: String(field.settings.target.recordTypeId) }
                : target,
            ];
          default:
            return [String(field.fieldId).toLowerCase(), target];
        }
      }),
    ),
  );

/**
 * How a cell edits every field of one module that people may change in a cell (field identity to
 * editor), from the installed field definition alone. A calculation, total, generated number,
 * money, table, attachment, several-choices or several-target link field has none, so it is never
 * offered. A single-target link names its installed target record type, found among `modules`.
 */
export const fieldEditorsOf = (
  module: PlacementModule,
  modules: readonly PlacementModule[],
): Record<string, RecordsTableInlineEditor> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field): [string, RecordsTableInlineEditor][] => {
        const required = field.required;
        const id = String(field.fieldId).toLowerCase();
        switch (field.type) {
          case "text":
            return [
              [id, { kind: "text", input: "text", maxLength: field.settings.maxLength, required }],
            ];
          case "long_text":
            return [
              [
                id,
                { kind: "text", input: "long_text", maxLength: field.settings.maxLength, required },
              ],
            ];
          case "email_address":
            return [[id, { kind: "text", input: "email", required }]];
          case "phone_number":
            return [[id, { kind: "text", input: "phone", required }]];
          case "web_address":
            return [[id, { kind: "text", input: "web", required }]];
          case "whole_number":
            return [
              [
                id,
                {
                  kind: "whole_number",
                  required,
                  ...(field.settings.minimum === undefined
                    ? {}
                    : { minimum: field.settings.minimum }),
                  ...(field.settings.maximum === undefined
                    ? {}
                    : { maximum: field.settings.maximum }),
                  ...(field.settings.step === undefined ? {} : { step: field.settings.step }),
                },
              ],
            ];
          case "decimal_number":
            return [
              [
                id,
                {
                  kind: "decimal",
                  required,
                  digitsBeforeDecimal: field.settings.digitsBeforeDecimal,
                  decimalPlaces: field.settings.decimalPlaces,
                  ...(field.settings.minimum === undefined
                    ? {}
                    : { minimum: field.settings.minimum }),
                  ...(field.settings.maximum === undefined
                    ? {}
                    : { maximum: field.settings.maximum }),
                },
              ],
            ];
          case "yes_no":
            return [[id, { kind: "yes_no", required }]];
          case "choice":
            return [
              [
                id,
                {
                  kind: "choice",
                  required,
                  options: field.settings.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                    ...(option.parentValues === undefined
                      ? {}
                      : { parentValues: option.parentValues }),
                  })),
                  ...(field.settings.dependsOn === undefined
                    ? {}
                    : {
                        dependsOnField: String(
                          field.settings.dependsOn.parentFieldId,
                        ).toLowerCase(),
                      }),
                },
              ],
            ];
          case "date":
            return [
              [
                id,
                {
                  kind: "date",
                  required,
                  ...(field.settings.earliest === undefined
                    ? {}
                    : { earliest: field.settings.earliest }),
                  ...(field.settings.latest === undefined ? {} : { latest: field.settings.latest }),
                },
              ],
            ];
          case "date_time":
            return [[id, { kind: "date_time", required }]];
          case "link": {
            if (field.settings.target.state !== "resolved") return [];
            const { moduleRootId, recordTypeId } = field.settings.target;
            const target = modules
              .find((candidate) => sameId(String(candidate.rootId), String(moduleRootId)))
              ?.content.recordTypes.find((candidate) =>
                sameId(String(candidate.recordTypeId), String(recordTypeId)),
              );
            return target === undefined
              ? []
              : [
                  [
                    id,
                    {
                      kind: "link",
                      required,
                      recordTypeId: String(recordTypeId),
                      targetLabel: target.singularLabel,
                      ...(field.settings.dependsOn === undefined
                        ? {}
                        : {
                            dependsOnField: String(
                              field.settings.dependsOn.parentFieldId,
                            ).toLowerCase(),
                          }),
                    },
                  ],
                ];
          }
          default:
            return [];
        }
      }),
    ),
  );

/** The display maps of one module, as a record detail and a records table project its fields. */
export const moduleFieldDisplay = (module: PlacementModule) => ({
  fieldLabels: fieldLabelsOf(module),
  fieldChoiceLabels: fieldChoiceLabelsOf(module),
  fieldDateTypes: fieldDateTypesOf(module),
  fieldLinkTypes: fieldLinkTypesOf(module),
  fieldTableColumns: fieldTableColumnsOf(module),
});

export type { IdentitySession, OrganizationSelectionCandidate };
