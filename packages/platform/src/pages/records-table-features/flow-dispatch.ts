import "server-only";

import { recordIdSchema, fieldIdSchema } from "../../catalogue/identifiers";
import { isRecord, sameId } from "../../catalogue/runtime-primitives";
import { recordsTableContractOrLog } from "../../definition/application-composition/records-display";
import { recordsTableInlineEditEvent } from "../../definition/application-composition/records-table-features/inline-edit";
import { recordsTableRowEditEvent } from "../../definition/application-composition/records-table-features/row-edit";
import type { ComponentFlowBinding } from "../../definition/application-flow-bindings";
import type { RequestDatabaseTransaction } from "../../db/request-transaction";
import type {
  BoundHumanOrganizationRequest,
  HumanOrganizationRequestResult,
} from "../../access/human-organization-request";
import { readCurrentOrganizationRuntimeSettingsAfterAuthorization } from "../../access/organization-runtime-settings-administration";
import { readCurrentRecordOwnerGroupsAfterAuthorization } from "../../access/record-owner-groups";
import type { JsonValue } from "../../catalogue/common";
import type { InstalledFlowBindings } from "../../definition/flow-binding-endpoint";
import {
  placementSettings,
  TABLE_BLOCK_RELEASE,
} from "../../definition/application-composition-catalogue";
import { projectRowActionAvailability } from "./row-actions";
import { fieldEditorsOf } from "../placement-read/shared";
import { pageSubjectFromRead, readPageSubjectInTransaction } from "../page-subject-read";
import {
  recordsTableRequestRefusal,
  rowMayChangeField,
  projectRecordsTableFeatures,
  type RecordsTableRequestRefusal,
} from ".";
import { installedPlacementProps } from "./placement";
import type { SelectedOrganizationScope } from "../../access/identity-access";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";
import { readQueryBindings } from "../../definition/application-composition/query-bindings";
import { protectedQueryCommandSchema } from "../../queries/protected-query-contracts";
import { readQueryMembership } from "../../queries/protected-query-table";
import {
  bindInvocationControls,
  resolveQueryBindings,
  type QueryBindingContext,
} from "../query-binding-resolver";
import { resolveProjectedTablePlacement } from "../projected-table-placement";
import type { PageDefinition } from "../../definition/application-contracts";
import {
  findModuleQuery,
  placementSettingsOf,
  type PlacementReadEntry,
} from "../placement-read/shared";

/** Proves supplied rows against the projected table's installed query under this request's scope. */
export const recordsTableMembershipRefusal = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstalledRuntimeContext,
  placement: PlacementReadEntry,
  bindings: QueryBindingContext,
  recordIds: readonly string[],
): Promise<string | undefined> => {
  const queryId =
    typeof placement.vortex.queryId === "string" ? placement.vortex.queryId : undefined;
  const bound = queryId === undefined ? undefined : findModuleQuery(context, queryId);
  if (bound === undefined) return "query_not_installed";
  const declared = readQueryBindings(placementSettingsOf(placement));
  if (declared.kind !== "read") return "query_bindings_malformed";
  const resolved = await resolveQueryBindings(declared.bindings, bound.query.inputs, bindings, {});
  if (resolved.kind !== "resolved") return `query_inputs_${resolved.kind}`;
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues: resolved.inputValues,
    requestedFieldIds: bound.query.selectedFieldIds.slice(0, 1),
    pageSize: recordIds.length,
    exactRecordIds: recordIds,
  });
  if (!command.success) return "query_membership_command_invalid";
  const result = await readQueryMembership(transaction, scope, command.data);
  if (result.outcome !== "completed") return `query_membership_${result.reasonCode}`;
  return recordIds.every((id) => result.recordIds.some((member) => sameId(id, member)))
    ? undefined
    : "record_not_in_query";
};

/** Resolves a projected table and its current bound inputs before proving exact row membership. */
export const projectedTableMembershipRefusal = async (
  bound: BoundHumanOrganizationRequest,
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
  pageDefinition: PageDefinition,
  request: Readonly<{
    placementId: string;
    subjectId: string | undefined;
    parameters: Readonly<Record<string, string | readonly string[]>>;
    controls: Readonly<Record<string, string>>;
    recordIds: readonly string[];
  }>,
  validateOption: (placementId: string, raw: string, parsed: JsonValue) => Promise<boolean>,
): Promise<string | undefined> => {
  if (
    request.recordIds.length === 0 ||
    request.recordIds.some((id) => !recordIdSchema.safeParse(id).success) ||
    new Set(request.recordIds.map((id) => id.toLowerCase())).size !== request.recordIds.length
  )
    return "record_selection_invalid";
  const table = resolveProjectedTablePlacement(page, request.placementId, {
    context,
    pageDefinition,
    parameters: request.parameters,
    subjectId: request.subjectId,
  });
  if (table.kind === "refused") return table.reason;
  const bindings = table.bindings({
    readSubject: (recordTypeId, recordId) =>
      readPageSubjectInTransaction(bound.transaction, { recordTypeId, recordId }),
    readTimeZone: async () =>
      (await readCurrentOrganizationRuntimeSettingsAfterAuthorization(bound.transaction))?.timeZone,
    readViewerTeams: async () =>
      (await readCurrentRecordOwnerGroupsAfterAuthorization(bound.transaction)).map(
        (group) => group.groupId,
      ),
  });
  const validated = await bindInvocationControls(bindings, request.controls, validateOption);
  if (validated === undefined) return "control_values_invalid";
  return recordsTableMembershipRefusal(
    bound.transaction,
    bound.scope,
    context,
    table.placement,
    validated,
    request.recordIds,
  );
};

/**
 * Why one inline-edited cell may not be written now, or undefined when it may: the field must be
 * changeable on this row by this viewer, readable on it, edited by an installed editor, and a link
 * is cleared or names a record of the field's installed target, never of the caller's choice of
 * type; the writer still decides whether the viewer may read it. Shared by the single edit and
 * every cell of a batch edit, so both decide a cell the same way.
 */
export const inlineEditCellRefusal = (
  row: Parameters<typeof rowMayChangeField>[0] &
    Readonly<{ values: Readonly<Record<string, unknown>> }>,
  field: string,
  editors: ReturnType<typeof fieldEditorsOf>,
  value: unknown,
): string | undefined => {
  if (
    !rowMayChangeField(row, field) ||
    !Object.keys(row.values).some((key) => sameId(key, field)) ||
    editors[field.toLowerCase()] === undefined
  )
    return `field_not_permitted:${field}`;
  const editor = editors[field.toLowerCase()];
  if (editor?.kind === "link" && value !== null) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      typeof value.recordTypeId !== "string" ||
      !sameId(value.recordTypeId, editor.recordTypeId)
    )
      return `link_target_type_mismatch:${field}`;
    if (!recordIdSchema.safeParse(value.recordId).success) return `link_record_invalid:${field}`;
  }
  return undefined;
};

/**
 * Re-project the requested row command under current access before starting any flow. All selected
 * rows are read in one database call; neither a browser projection nor a previous page read grants
 * authority. The rows come from the gesture's own inputs, never from the page subject: a table on a
 * record's page lists other records. A supplied row revision must still be current; the protected
 * writer checks permission and revision again at the actual write.
 *
 * An inline edit names its one field as the single key of the `values` input and its displayed
 * revision as the gesture's subject. The field must be authored, shown to this viewer and changeable
 * on this row now. A stale revision is not refused here: the writer compares it atomically and the
 * person gets a conflict they can resolve, not a neutral refusal.
 */
export const recordsTableBindingRefusal = async (
  installation: InstalledFlowBindings,
  binding: ComponentFlowBinding,
  inputs: Readonly<Record<string, unknown>>,
  subject: Readonly<{ recordId: string; revision: number }> | undefined,
  run: <Result>(
    operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
  ) => Promise<HumanOrganizationRequestResult<Result>>,
): Promise<RecordsTableRequestRefusal | undefined> => {
  const event = binding.event;
  if (
    event !== "row_action" &&
    event !== "row_clicked" &&
    event !== "bulk_action" &&
    event !== recordsTableInlineEditEvent &&
    event !== recordsTableRowEditEvent
  )
    return undefined;
  const props = installedPlacementProps(installation.applicationContent, binding.controlId);
  if (props === undefined) return recordsTableRequestRefusal("contract", "placement_not_installed");
  const vortex = props.vortex;
  if (!isRecord(vortex) || !isRecord(vortex.block))
    return recordsTableRequestRefusal("contract", "placement_metadata_unreadable");
  if (vortex.block.blockId !== TABLE_BLOCK_RELEASE.blockId) {
    // A block without a row-action list names its one row action in `row_action_event_id`; a
    // `row_action` binding of any other identity is not a compiled binding of that placement.
    if (event !== "row_action") return undefined;
    const declared = placementSettings(props).row_action_event_id;
    return declared?.kind === "text" && sameId(declared.value, binding.eventId)
      ? undefined
      : recordsTableRequestRefusal(event, "command_not_declared");
  }
  const contract = recordsTableContractOrLog(placementSettings(props), "flow dispatch");
  if (contract === undefined)
    return recordsTableRequestRefusal("contract", "placement_contract_unreadable");
  // A bulk action runs a named action through the table's own bulk run, never a flow binding.
  if (event === "bulk_action") return recordsTableRequestRefusal(event, "command_not_declared");
  const command =
    event === "row_action"
      ? contract.rowBehaviours.rowActions.find((action) => sameId(action.eventId, binding.eventId))
      : undefined;
  if (event === "row_action" && !contract.features.rowActions.enabled)
    return recordsTableRequestRefusal(event, "feature_off");
  if (event === "row_action" && command === undefined)
    return recordsTableRequestRefusal(event, "command_not_declared");
  if (
    event === "row_clicked" &&
    (contract.rowBehaviours.rowClick === undefined ||
      contract.rowBehaviours.rowClick.selectsRecord ||
      !sameId(contract.rowBehaviours.rowClick.eventId, binding.eventId))
  )
    return recordsTableRequestRefusal(event, "command_not_declared");
  const editing = event === recordsTableInlineEditEvent || event === recordsTableRowEditEvent;
  const inline =
    event === recordsTableRowEditEvent ? contract.features.rowEdit : contract.features.inlineEdit;
  let editedFields: string[] = [];
  if (editing) {
    if (!inline.enabled) return recordsTableRequestRefusal(event, "feature_off");
    if (inline.eventId === undefined || !sameId(inline.eventId, binding.eventId))
      return recordsTableRequestRefusal(event, "binding_not_declared");
    const values = inputs.values;
    const names = isRecord(values) ? Object.keys(values) : [];
    if (
      (event === recordsTableInlineEditEvent && names.length !== 1) ||
      names.length === 0 ||
      names.length > 50
    )
      return recordsTableRequestRefusal(event, "changed_fields_invalid");
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
      return recordsTableRequestRefusal(event, "changed_fields_duplicated");
    if (names.some((field) => !fieldIdSchema.safeParse(field).success))
      return recordsTableRequestRefusal(event, "field_identity_invalid");
    editedFields = names;
    for (const field of editedFields)
      if (
        !inline.fields.some((allowed) => sameId(allowed, field)) ||
        !contract.columns.some((column) => sameId(column.field, field))
      )
        return recordsTableRequestRefusal(event, `field_not_editable:${field}`);
    if (subject === undefined) return recordsTableRequestRefusal(event, "revision_missing");
  }
  const queries = (installation.modules ?? []).flatMap((module) =>
    module.content.queries.filter(
      (query) => typeof vortex.queryId === "string" && sameId(query.queryId, vortex.queryId),
    ),
  );
  const query = queries.length === 1 ? queries[0] : undefined;
  if (query?.recordType.state !== "resolved")
    return recordsTableRequestRefusal("contract", "query_not_installed");
  const recordTypeId = query.recordType.recordTypeId;
  const candidates = [inputs.record_id];
  const recordIds: string[] = [];
  for (const candidate of candidates) {
    // A selected-record read carries the existing typed reference input; ordinary row gestures
    // carry the ID. In both cases the installed query, never the caller, supplies the record type.
    if (
      isRecord(candidate) &&
      (Object.keys(candidate).length !== 2 ||
        typeof candidate.recordTypeId !== "string" ||
        !sameId(candidate.recordTypeId, recordTypeId))
    )
      return recordsTableRequestRefusal(event, "record_type_mismatch");
    const parsed = recordIdSchema.safeParse(isRecord(candidate) ? candidate.recordId : candidate);
    if (!parsed.success || recordIds.some((id) => sameId(id, parsed.data)))
      return recordsTableRequestRefusal(event, "record_selection_invalid");
    recordIds.push(parsed.data);
  }
  const revision = inputs.revision;
  if (revision !== undefined && typeof revision !== "number")
    return recordsTableRequestRefusal(event, "revision_invalid");
  // Edits and row commands carry their displayed row as the subject; opening a row keeps page context.
  if (
    editing &&
    subject !== undefined &&
    (recordIds.length !== 1 || !sameId(subject.recordId, recordIds[0] as string))
  )
    return recordsTableRequestRefusal(event, "subject_not_the_record");
  const read = await run(async (transaction) => {
    const rows = await transaction.query<{
      record_id: string;
      record: unknown;
      capabilities: unknown;
    }>`
      with current_records as materialized (
        select target.value::uuid as record_id,
          vortex_record.read_record(${recordTypeId}::uuid, target.value::uuid) as value
        from pg_catalog.jsonb_array_elements_text(${JSON.stringify(recordIds)}::text::jsonb) as target(value)
      )
      select record_id, value -> 'record' as record, value -> 'capabilities' as capabilities
      from current_records
    `;
    if (rows.length !== recordIds.length) throw new Error("GRID_COMMAND_RECORDS_MISSING");
    for (const result of rows) {
      const current = pageSubjectFromRead(result.record, result.capabilities, result.record_id);
      if (current.kind !== "read") return recordsTableRequestRefusal(event, "record_not_readable");
      const row = current.row;
      if (revision !== undefined && row.revision !== revision)
        return recordsTableRequestRefusal(event, "revision_not_current");
      if (
        command?.capability !== undefined &&
        !row.capabilities?.actions.includes(command.capability)
      )
        return recordsTableRequestRefusal(event, "command_not_permitted");
      if (event === "row_action") {
        if (
          row.revision === undefined ||
          subject === undefined ||
          !sameId(subject.recordId, row.recordId) ||
          subject.revision !== row.revision
        )
          return recordsTableRequestRefusal(event, "displayed_revision_not_current");
        const projected = projectRecordsTableFeatures(
          contract,
          { readableFieldIds: [], searchable: false },
          [row],
          undefined,
          undefined,
        )?.rowActions;
        if (projected === undefined || installation.namedActions === undefined)
          return recordsTableRequestRefusal(event, "feature_not_projected");
        // Only the invoked command is re-decided; the row's other commands are not this request's.
        const invoked = <Decision extends { action: string }>(actions: readonly Decision[]) =>
          actions.filter((action) => sameId(action.action, binding.eventId));
        const current = await projectRowActionAvailability(
          transaction,
          { ...installation, namedActions: installation.namedActions },
          binding.controlId,
          recordTypeId,
          {
            actions: projected.actions.filter((action) => sameId(action.eventId, binding.eventId)),
            availability: projected.availability.map((entry) => ({
              ...entry,
              actions: invoked(entry.actions),
            })),
          },
          new Date().toISOString(),
        );
        const decision = current.availability[0]?.actions.find((action) =>
          sameId(action.action, binding.eventId),
        );
        if (decision?.eligible !== true)
          return recordsTableRequestRefusal(event, decision?.reason ?? "command_not_projected");
      }
      if (editing) {
        const module = installation.modules?.find((entry) => entry.content.queries.includes(query));
        if (module === undefined) return recordsTableRequestRefusal(event, "query_module_missing");
        const editors = fieldEditorsOf(module, installation.modules ?? []);
        if (event === recordsTableRowEditEvent) {
          const projection = projectRecordsTableFeatures(
            contract,
            {
              readableFieldIds: Object.keys(row.values).map((field) => fieldIdSchema.parse(field)),
              searchable: false,
            },
            [row],
            undefined,
            editors,
          );
          if (projection?.rowEdit === undefined)
            return recordsTableRequestRefusal(event, "feature_not_projected");
          for (const field of editedFields)
            if (!projection.rowEdit.fields.some((allowed) => sameId(allowed.field, field)))
              return recordsTableRequestRefusal(event, `field_not_projected:${field}`);
        }
        for (const field of editedFields) {
          const cause = inlineEditCellRefusal(
            row,
            field,
            editors,
            isRecord(inputs.values) ? inputs.values[field] : undefined,
          );
          if (cause !== undefined) return recordsTableRequestRefusal(event, cause);
        }
      }
    }
    return undefined;
  });
  return read.kind === "available"
    ? read.value
    : recordsTableRequestRefusal(event, "current_access_unavailable");
};
