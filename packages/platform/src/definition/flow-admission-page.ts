import "server-only";

import type { BoundHumanOrganizationRequest } from "../access/human-organization-request";
import { recordIdSchema } from "../catalogue/identifiers";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { readPageSubjectInTransaction } from "../pages/page-subject-read";
import { requireProjectedPlacement } from "../pages/projected-placement-gate";
import { pageSubjectType } from "../pages/projected-table-placement";
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
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowControlOptionRequest, FlowInvocationRequest } from "./flow-invocation";
import type { InstalledRuntimeContext } from "./installed-runtime-context";

type PageAdmissionHost = Readonly<{
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
  const inputs =
    request.invocation.kind === "binding"
      ? (request.invocation.callerInputs ?? {})
      : Object.fromEntries(
          Object.entries(state.activations[0]?.inputs ?? {}).map(([name, value]) => [
            name,
            value.value,
          ]),
        );
  if (rowForm) {
    const source = [...plans.rowFormsByTable].find(
      ([id]) => sourceTableId !== undefined && sameId(id, sourceTableId),
    );
    if (
      source === undefined ||
      ![...source[1]].some((id) => sameId(id, binding.controlId)) ||
      state.subject === undefined
    ) {
      console.error("[flows] row form source or subject unavailable");
      return false;
    }
    tableId = source[0];
    recordId = state.subject.recordId;
  } else if (
    binding.event === "row_action" ||
    binding.event === "row_clicked" ||
    binding.event === "bulk_action" ||
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
        console.error("[flows] table row selection invalid");
        return false;
      }
      recordId = parsed.data;
    }
  }
  const refusal = await recordsTableBindingRefusal(
    installation,
    binding,
    inputs,
    state.subject,
    async (operation) => ({ kind: "available", value: await operation(bound.transaction) }),
  );
  if (refusal !== undefined) {
    console.error(`[flows] table binding refused: ${refusal.reason}`);
    return false;
  }
  if (tableId === undefined || recordId === undefined) return true;
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
    console.error("[flows] page subject unavailable for control proof");
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
      recordIds: [recordId],
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
    console.error(`[flows] table row membership refused: ${membership}`);
    return false;
  }
  return (
    !rowForm ||
    host.projectRowForm(bound, context, page, tableId, String(binding.controlId), recordId)
  );
};
