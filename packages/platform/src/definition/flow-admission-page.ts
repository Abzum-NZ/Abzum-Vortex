import "server-only";

import type { BoundHumanOrganizationRequest } from "../access/human-organization-request";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { logFault, logRefusal } from "../access/request-failure";
import { recordIdSchema } from "../catalogue/identifiers";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { readPageSubjectInTransaction } from "../pages/page-subject-read";
import { requireProjectedPlacement } from "../pages/projected-placement-gate";
import { pageSubjectType } from "../pages/projected-table-placement";
import { logRecordsTableRequestRefusal } from "../pages/records-table-features";
import {
  projectedTableMembershipRefusal,
  recordsTableBindingRefusal,
} from "../pages/records-table-features/flow-dispatch";
import type { FlowRunState } from "../rules/flow-interpreter";
import { flowPlansOf } from "../workflows/flow-plan";
import { TABLE_BLOCK_RELEASE } from "./application-composition-catalogue";
import { recordsTableInlineEditEvent } from "./application-composition/records-table-features/inline-edit";
import { recordsTableRowEditEvent } from "./application-composition/records-table-features/row-edit";
import type { ComponentFlowBinding } from "./application-flow-bindings";
import { canonicalJson } from "./canonical-json";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowControlOptionRequest, FlowInvocationRequest } from "./flow-invocation";
import type { InstalledRuntimeContext } from "./installed-runtime-context";

type PageAdmissionHost = Readonly<{
  permissions: PlatformPermissionSource;
  validateOption: (input: FlowControlOptionRequest) => Promise<boolean>;
  projectRowForm: (
    bound: BoundHumanOrganizationRequest,
    context: InstalledRuntimeContext,
    page: Readonly<Record<string, unknown>>,
    sourceTableId: string,
    formId: string,
    recordId: string,
  ) => Promise<boolean>;
}>;

/** Rechecks row gestures and row-form subjects under the admitted page's current scope. */
export const admitPageGesture = async (
  host: PageAdmissionHost,
  bound: BoundHumanOrganizationRequest,
  context: InstalledRuntimeContext,
  installation: InstalledFlowBindings,
  page: Readonly<Record<string, unknown>>,
  request: FlowInvocationRequest,
  binding: ComponentFlowBinding,
  state: FlowRunState,
): Promise<boolean> => {
  const pageDefinition = context.releaseSet.application.content.pages.find(
    (candidate) => candidate.key === request.pageKey,
  );
  if (pageDefinition === undefined) return false;
  const plans = flowPlansOf(context.releaseSet);
  const rowForms = [...plans.rowFormsByTable.values()];
  const rowForm = rowForms.some((forms) => [...forms].some((id) => sameId(id, binding.controlId)));
  const sourceTableId = request.invocation.sourceTablePlacementId;
  let tableId: string | undefined;
  let recordId: string | undefined;
  /** The chosen records of a bulk action, each proven to be a row of the table. */
  let bulkRecordIds: string[] | undefined;
  const inputs: Record<string, unknown> = Object.create(null);
  if (request.invocation.kind === "binding") {
    Object.assign(inputs, request.invocation.callerInputs ?? {});
  } else {
    // The admitted segment names flow inputs; table checks use the binding's caller names.
    // Reconstruct only values the original binding actually accepted from the caller.
    const activation = state.activations[0];
    if (activation === undefined) return false;
    for (const [name, source] of Object.entries(binding.flow.inputs)) {
      if (!isRecord(source) || source.kind !== "caller" || typeof source.name !== "string")
        continue;
      const input = activation.inputs[name];
      if (input === undefined) continue;
      if (
        source.name in inputs &&
        canonicalJson(inputs[source.name]) !== canonicalJson(input.value)
      )
        return false;
      inputs[source.name] = input.value;
    }
  }
  if (rowForm) {
    const source = [...plans.rowFormsByTable].find(
      ([id]) => sourceTableId !== undefined && sameId(id, sourceTableId),
    );
    if (
      source === undefined ||
      ![...source[1]].some((id) => sameId(id, binding.controlId)) ||
      state.subject === undefined
    ) {
      // The browser names the source table and the record: an expected refusal.
      logRefusal("flows", "row form admission", "row_form_source_or_subject_unavailable");
      return false;
    }
    tableId = source[0];
    recordId = state.subject.recordId;
  } else if (
    binding.event === "row_action" ||
    binding.event === "row_clicked" ||
    binding.event === recordsTableInlineEditEvent ||
    binding.event === recordsTableRowEditEvent
  ) {
    const gate = requireProjectedPlacement(page, binding.controlId);
    if (gate.kind !== "on_page") return false;
    const block = gate.placement.vortex.block;
    if (
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, TABLE_BLOCK_RELEASE.blockId)
    ) {
      tableId = String(binding.controlId);
      const candidate = inputs.record_id;
      const parsed = recordIdSchema.safeParse(isRecord(candidate) ? candidate.recordId : candidate);
      if (!parsed.success) {
        logRefusal("flows", "table row admission", "row_selection_invalid");
        return false;
      }
      recordId = parsed.data;
    }
  }
  if (binding.event === "bulk_action") {
    const gate = requireProjectedPlacement(page, binding.controlId);
    if (gate.kind !== "on_page") return false;
    tableId = String(binding.controlId);
    const chosen = [inputs.subjects, inputs.queued].flatMap((list) =>
      Array.isArray(list) ? list : [],
    );
    bulkRecordIds = chosen.flatMap((entry) =>
      Array.isArray(entry) && typeof entry[0] === "string" ? [entry[0]] : [],
    );
  }
  const refusal = await recordsTableBindingRefusal(
    installation,
    binding,
    inputs,
    state.subject,
    host.permissions,
    async (operation) => ({
      kind: "available",
      value: await operation(bound.transaction, bound.scope),
    }),
  );
  if (refusal !== undefined) {
    logRecordsTableRequestRefusal(refusal, "flow_admission");
    return false;
  }
  const recordIds = bulkRecordIds ?? (recordId === undefined ? undefined : [recordId]);
  // A bulk run over every matching record names no row: its own sealed selection stands for them.
  if (tableId === undefined || recordIds === undefined || recordIds.length === 0) return true;
  const pageType = pageSubjectType(pageDefinition);
  const pageRecord = recordIdSchema.safeParse(request.pageRecordId);
  const subject =
    pageType !== undefined && pageRecord.success
      ? { recordTypeId: String(pageType.recordTypeId), recordId: pageRecord.data }
      : undefined;
  const held =
    subject === undefined
      ? undefined
      : await readPageSubjectInTransaction(bound.transaction, subject);
  if (subject !== undefined && held?.kind !== "read") {
    // A subject read that failed logged its own line, once; a subject the person may not read now
    // is an expected refusal.
    if (held?.kind === "refused") logRefusal("flows", "control proof", "page_subject_refused");
    return false;
  }
  const membership = await projectedTableMembershipRefusal(
    bound,
    context,
    page,
    pageDefinition,
    {
      placementId: tableId,
      subjectId: request.pageRecordId,
      parameters: request.pageInputs.parameters,
      controls: request.pageInputs.controls,
      recordIds,
    },
    (placementId, raw, parsed) =>
      host.validateOption({
        bound,
        context,
        page,
        placementId,
        raw,
        parsed,
        subject,
        heldValues: held?.kind === "read" ? held.row.values : {},
        controls: request.pageInputs.controls,
      }),
  );
  if (membership !== undefined) {
    // A refusal the query logged adds no line; a definition that cannot answer is a fault; any
    // other is the answer to what was supplied.
    if (membership.logged !== true)
      (membership.fault === true ? logFault : logRefusal)(
        "flows",
        "table row membership",
        membership.reason,
      );
    return false;
  }
  return (
    !rowForm ||
    (recordId !== undefined &&
      host.projectRowForm(bound, context, page, tableId, String(binding.controlId), recordId))
  );
};
