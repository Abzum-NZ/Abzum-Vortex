import "server-only";

import type {
  BoundHumanOrganizationRequest,
  HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { createReferenceChoiceService } from "../queries/reference-choice-service";
import { adaptPrivateFormSubmit } from "../pages/form-request";
import { requireProjectedPlacement } from "../pages/projected-placement-gate";
import { findModuleQuery } from "../pages/placement-read/shared";
import type { FlowRunState } from "../rules/flow-interpreter";
import type { ComponentFlowBinding } from "./application-flow-bindings";
import { canonicalJson } from "./canonical-json";
import type { FlowInvocationRequest, InvocationDependencies } from "./flow-invocation";
import type { InstalledRuntimeContext } from "./installed-runtime-context";

/** Reprojects and validates a row form using the row already proved by its source table. */
export const admitRowForm = async (
  dependencies: Pick<
    InvocationDependencies,
    "projectRowForm" | "resolveFormValues" | "continuationKey"
  >,
  requests: HumanOrganizationRequestDependencies,
  bound: BoundHumanOrganizationRequest,
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
  request: FlowInvocationRequest,
  binding: ComponentFlowBinding,
  state: FlowRunState,
  tableId: string,
  formId: string,
  recordId: string,
): Promise<boolean> => {
  const table = requireProjectedPlacement(page, tableId);
  const pageDefinition = context.releaseSet.application.content.pages.find(
    (candidate) => candidate.key === request.pageKey,
  );
  if (table.kind !== "on_page" || pageDefinition === undefined) return false;
  const queryId = table.placement.vortex.queryId;
  const query = typeof queryId === "string" ? findModuleQuery(context, queryId) : undefined;
  if (query === undefined || query.query.recordType.state !== "resolved") return false;
  const form = await dependencies.projectRowForm(
    bound,
    context,
    page,
    String(pageDefinition.pageId),
    formId,
    {
      moduleRootId: String(query.module.rootId),
      recordTypeId: String(query.query.recordType.recordTypeId),
      recordId,
    },
  );
  if (
    form === undefined ||
    request.invocation.kind !== "binding" ||
    binding.event !== "form_submit"
  ) {
    console.error("[flows] row form projection or submission unavailable");
    return false;
  }
  const callerInputs = request.invocation.callerInputs ?? {};
  const values = await dependencies.resolveFormValues({
    service: createReferenceChoiceService({
      ...requests,
      boundRequest: bound,
      continuationKey: dependencies.continuationKey,
    }),
    session: bound.session,
    selection: bound.selection,
    application: context.releaseSet.application.content,
    modules: context.releaseSet.modules,
    formId,
    projectedFields: form.fields,
    values: callerInputs.values,
    ...(callerInputs.choiceEvidence === undefined ? {} : { evidence: callerInputs.choiceEvidence }),
  });
  if (values === undefined) return false;
  const adaptedInputs: Record<string, unknown> = { ...callerInputs };
  delete adaptedInputs.choiceEvidence;
  const adapted = adaptPrivateFormSubmit(binding, { ...adaptedInputs, values }, state.subject);
  const activation = state.activations[0];
  if (adapted === undefined || activation === undefined) return false;
  const flow =
    context.releaseSet.application.content.flows.find((entry) =>
      sameId(entry.id, binding.flow.flowId),
    ) ??
    context.releaseSet.modules
      .flatMap((module) => module.content.flows)
      .find((entry) => sameId(entry.id, binding.flow.flowId));
  if (flow === undefined) return false;
  for (const [name, input] of Object.entries(binding.flow.inputs)) {
    if (!isRecord(input) || input.kind !== "caller" || typeof input.name !== "string") continue;
    let expected = adapted[input.name];
    if (flow.inputs[name]?.type === "record_reference" && isRecord(expected))
      expected = expected.recordId;
    const actual = activation.inputs[name]?.value;
    if (
      expected === undefined ||
      actual === undefined ||
      canonicalJson(expected) !== canonicalJson(actual)
    ) {
      console.error("[flows] row form values changed before admission");
      return false;
    }
  }
  return true;
};
