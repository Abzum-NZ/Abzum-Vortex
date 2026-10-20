import "server-only";

import { isRecord, readRecordsTableContract, recordIdSchema, sameId } from "../../schema";
import type { ComponentFlowBinding } from "../../schema";
import type { RequestDatabaseTransaction } from "../../db";
import type { HumanOrganizationRequestResult } from "../../access";
import type { InstalledFlowBindings } from "../../definition/flow-binding-endpoint";
import {
  placementSettings,
  TABLE_BLOCK_RELEASE,
} from "../../definition/application-composition-catalogue";
import { pageSubjectFromRead } from "../page-subject-read";
import { recordsTableRequestRefusal, rowMayChangeField, type RecordsTableRequestRefusal } from ".";

/** Locate the exact compiled placement; bindings of other block types keep their own gates. */
export const installedPlacementProps = (
  content: unknown,
  placementId: string,
): Record<string, unknown> | undefined => {
  if (Array.isArray(content)) {
    for (const entry of content) {
      const found = installedPlacementProps(entry, placementId);
      if (found !== undefined) return found;
    }
  } else if (isRecord(content)) {
    if (
      typeof content.type === "string" &&
      isRecord(content.props) &&
      typeof content.props.id === "string" &&
      sameId(content.props.id, placementId)
    )
      return content.props;
    for (const nested of Object.values(content)) {
      const found = installedPlacementProps(nested, placementId);
      if (found !== undefined) return found;
    }
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
    event !== "inline_edit"
  )
    return undefined;
  const props = installedPlacementProps(installation.applicationContent, binding.controlId);
  if (props === undefined) return recordsTableRequestRefusal("contract", "placement_not_installed");
  const vortex = props.vortex;
  if (!isRecord(vortex) || !isRecord(vortex.block))
    return recordsTableRequestRefusal("contract", "placement_metadata_unreadable");
  if (vortex.block.blockId !== TABLE_BLOCK_RELEASE.blockId) return undefined;
  const contract = readRecordsTableContract(placementSettings(props));
  if (contract === undefined)
    return recordsTableRequestRefusal("contract", "placement_contract_unreadable");
  // A bulk action runs a named action through the table's own bulk run, never a flow binding.
  if (event === "bulk_action") return recordsTableRequestRefusal(event, "command_not_declared");
  const command =
    event === "row_action"
      ? contract.rowBehaviours.rowActions.find((action) => sameId(action.eventId, binding.eventId))
      : undefined;
  if (event === "row_action" && command === undefined)
    return recordsTableRequestRefusal(event, "command_not_declared");
  if (
    event === "row_clicked" &&
    (contract.rowBehaviours.rowClick === undefined ||
      contract.rowBehaviours.rowClick.selectsRecord ||
      !sameId(contract.rowBehaviours.rowClick.eventId, binding.eventId))
  )
    return recordsTableRequestRefusal(event, "command_not_declared");
  const inline = contract.features.inlineEdit;
  let editedField: string | undefined;
  if (event === "inline_edit") {
    if (!inline.enabled) return recordsTableRequestRefusal(event, "feature_off");
    if (inline.eventId === undefined || !sameId(inline.eventId, binding.eventId))
      return recordsTableRequestRefusal(event, "binding_not_declared");
    const values = inputs.values;
    const names = isRecord(values) ? Object.keys(values) : [];
    if (names.length !== 1) return recordsTableRequestRefusal(event, "values_not_one_field");
    editedField = names[0];
    if (
      editedField === undefined ||
      !inline.fields.some((field) => sameId(field, editedField as string))
    )
      return recordsTableRequestRefusal(event, "field_not_editable");
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
  if (
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
      select target.value::uuid as record_id,
        vortex_record.read_record(${recordTypeId}::uuid, target.value::uuid) as record,
        vortex_record.read_record_capabilities(${recordTypeId}::uuid, target.value::uuid) as capabilities
      from pg_catalog.jsonb_array_elements_text(${JSON.stringify(recordIds)}::text::jsonb) as target(value)
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
      if (
        event === "inline_edit" &&
        (editedField === undefined || !rowMayChangeField(row, editedField))
      )
        return recordsTableRequestRefusal(event, "field_not_permitted");
    }
    return undefined;
  });
  return read.kind === "available"
    ? read.value
    : recordsTableRequestRefusal(event, "current_access_unavailable");
};
