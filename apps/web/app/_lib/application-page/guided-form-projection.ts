import {
  computeGuidedFormStepId,
  earlierGuidedStepId,
  getGuidedFormFlowId,
  getGuidedFormRecordType,
  getGuidedFormStepFields,
  getGuidedFormVisiblePlacementIds,
  guidedFormDraftScope,
  guidedFormInitialValues,
  guidedFormInputData,
  openGuidedFormDraft,
  visibleGuidedFormValidation,
  visibleGuidedFormValues,
  type DateTimeZones,
  type InstalledRuntimeContext,
  type PageSubjectReadResult,
  type RecordLinkResolver,
} from "@vortex/platform/server";
import type {
  IdentitySession,
  PageDefinition,
  OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { guidedFormDependencies } from "../guided-form-dependencies";
import { titleLinkInputs } from "./link-input";
import { first, pageSubjectParameter } from "./placement-helpers";
import type {
  ApplicationPageInternalResult,
  ApplicationPageModel,
  PageDataState,
  SearchParameters,
} from "./types";

/**
 * The guided form a guided page shows: its record type, its steps' fields as the person's
 * revisioned draft holds them, the active step and the draft's validation. Returns a refusal to
 * answer the page with, or the guided form (its field data is added to `data`).
 */
export const projectGuidedForm = async (
  input: Readonly<{
    context: InstalledRuntimeContext;
    pageDefinition: Extract<PageDefinition, { type: "guided_form" }>;
    page: Readonly<Record<string, unknown>>;
    parameters: SearchParameters;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    subjectRow: PageSubjectReadResult | undefined;
    subject: Readonly<{ recordId: string }> | undefined;
    dateTimeZones: DateTimeZones;
    resolveRecordLinks: RecordLinkResolver;
    data: Record<string, PageDataState>;
  }>,
): Promise<
  | Readonly<{ kind: "projected"; guidedForm: NonNullable<ApplicationPageModel["guidedForm"]> }>
  | Readonly<{ kind: "refused"; result: ApplicationPageInternalResult }>
> => {
  const {
    context,
    pageDefinition,
    page,
    parameters,
    session,
    selection,
    subjectRow,
    subject,
    dateTimeZones,
    resolveRecordLinks,
    data,
  } = input;
  const application = context.releaseSet.application;
  const subjectCandidate = first(parameters[pageSubjectParameter]);
  if (subjectCandidate !== undefined) {
    if (subjectRow?.kind === "temporarily_unavailable")
      return { kind: "refused", result: { kind: "temporarily_unavailable" } };
    if (subjectRow?.kind !== "read" || subject === undefined)
      return { kind: "refused", result: { kind: "unavailable" } };
  }
  const recordType = getGuidedFormRecordType(pageDefinition, context.releaseSet.modules);
  if (recordType === undefined) return { kind: "refused", result: { kind: "unavailable" } };
  const shells = context.releaseSet.application.content.shells;
  const declaredStepFields = getGuidedFormStepFields(pageDefinition, recordType, shells);
  const visiblePlacementIds = getGuidedFormVisiblePlacementIds(page, shells);
  const stepFields = getGuidedFormStepFields(pageDefinition, recordType, shells, page);
  const flowId = getGuidedFormFlowId(page, application.content.flowBindings, shells);
  if (
    declaredStepFields === undefined ||
    visiblePlacementIds === undefined ||
    stepFields === undefined ||
    declaredStepFields.some((step) =>
      step.fields.some(
        (field) => field.required && !visiblePlacementIds.has(field.placementId.toLowerCase()),
      ),
    ) ||
    flowId === undefined
  )
    return { kind: "refused", result: { kind: "unavailable" } };
  const draftScope = guidedFormDraftScope(String(pageDefinition.pageId), flowId, subject?.recordId);
  const openedDraft = await openGuidedFormDraft(
    guidedFormDependencies(),
    session,
    selection,
    draftScope,
    guidedFormInitialValues(
      stepFields,
      subjectRow?.kind === "read" ? subjectRow.row.values : undefined,
    ),
  );
  if (openedDraft.kind !== "available") return { kind: "refused", result: openedDraft };
  const values = visibleGuidedFormValues(openedDraft.draft, stepFields);
  const computedStepId = computeGuidedFormStepId(stepFields, openedDraft.draft.validation);
  if (computedStepId === undefined) return { kind: "refused", result: { kind: "unavailable" } };
  const activeStepId = earlierGuidedStepId(stepFields, computedStepId, first(parameters.step));
  const stepData = {
    ...guidedFormInputData(page, recordType, values, dateTimeZones),
  } as Record<string, PageDataState>;
  // A linked record shows by its title, read under the viewer's access.
  if ((await titleLinkInputs(stepData, resolveRecordLinks)).size > 0)
    return { kind: "refused", result: { kind: "unavailable" } };
  Object.assign(data, stepData);
  return {
    kind: "projected",
    guidedForm: {
      draftId: String(openedDraft.draft.draftId),
      revision: openedDraft.draft.revision,
      flowId,
      activeStepId,
      computedStepId,
      values,
      validation: visibleGuidedFormValidation(openedDraft.draft.validation, stepFields),
    },
  };
};
