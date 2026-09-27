"use server";

import {
  builderKeySchema,
  containedComponentIdSchema,
  jsonValueSchema,
  organizationSelectionCandidateSchema,
  platformIdSchema,
  recordIdSchema,
  revisionSchema,
} from "@vortex/contracts";
import { z } from "zod";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { loadApplicationPage } from "../../../_lib/application-page";
import {
  computeGuidedFormStepId,
  createGuidedFormDraftService,
  getGuidedFormVisiblePlacementIds,
  guidedFormDraftScope,
  earlierGuidedStepId,
  loadGuidedFormAuthorityForSession,
  validateGuidedFormStep,
  visibleGuidedFormValues,
  visibleGuidedFormValidation,
  type GuidedFormAbandonRequest,
  type GuidedFormConfirmRequest,
  type GuidedFormConfirmResult,
  type GuidedFormPageAddress,
  type GuidedFormStepActionResult,
  type GuidedFormStepRequest,
} from "../../../_lib/guided-form-steps";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";

const actionAddressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(120),
    organizationShortName: z.string().min(1).max(120),
    applicationKey: z.string().min(1).max(120),
    pageKey: z.string().min(1).max(120),
    subjectRecordId: recordIdSchema.optional(),
  })
  .strict();

const stepRequestSchema = z
  .object({
    address: actionAddressSchema,
    draftId: platformIdSchema,
    expectedRevision: revisionSchema,
    stepId: containedComponentIdSchema,
    requestedStepId: containedComponentIdSchema.optional(),
    values: z.record(builderKeySchema, jsonValueSchema),
  })
  .strict();

const confirmRequestSchema = z
  .object({
    address: actionAddressSchema,
    draftId: platformIdSchema,
    expectedRevision: revisionSchema,
    stepId: containedComponentIdSchema,
  })
  .strict();

const abandonRequestSchema = z
  .object({
    address: actionAddressSchema,
    draftId: platformIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const parseAddress = (candidate: unknown): GuidedFormPageAddress | undefined => {
  const parsed = actionAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

const loadActionPage = async (addressCandidate: unknown) => {
  const address = parseAddress(addressCandidate);
  if (address === undefined) return { kind: "unavailable" as const };
  const identity = continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" as const };
  const resolved = await resolveApplicationAddress(
    identity.session,
    address.tenantShortName,
    address.organizationShortName,
    address.applicationKey,
    address.pageKey,
  );
  if (resolved.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" as const };
  if (resolved.kind !== "application_page") return { kind: "unavailable" as const };
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: resolved.read.organizationId,
    applicationRootId: resolved.application.applicationRootId,
  });
  const loaded = await loadApplicationPage(
    identity.session,
    {
      tenantShortName: address.tenantShortName,
      organizationShortName: address.organizationShortName,
      read: resolved.read,
      application: resolved.application,
      pageKey: resolved.pageKey,
    },
    address.subjectRecordId === undefined ? {} : { record_id: address.subjectRecordId },
  );
  if (loaded.kind !== "available") return loaded;
  if (loaded.model.guidedForm === undefined) return { kind: "unavailable" as const };
  return {
    kind: "available" as const,
    address,
    session: identity.session,
    selection,
    model: loaded.model,
  };
};

const requestMetadata = async (loaded: Awaited<ReturnType<typeof loadActionPage>>) => {
  if (loaded.kind !== "available") return loaded;
  const guidedForm = loaded.model.guidedForm;
  if (guidedForm === undefined) return { kind: "unavailable" as const };
  const scope = guidedFormDraftScope(
    loaded.model.pageId,
    guidedForm.flowId,
    loaded.model.subject?.recordId,
  );
  const authority = await loadGuidedFormAuthorityForSession(
    loaded.session,
    loaded.selection,
    scope,
  );
  if (authority.kind !== "available") return authority;
  if (authority.value === undefined) return { kind: "unavailable" as const };
  const visiblePlacementIds = getGuidedFormVisiblePlacementIds(loaded.model.page);
  if (visiblePlacementIds === undefined) return { kind: "unavailable" as const };
  const steps = authority.value.steps.map((step) => ({
    ...step,
    fields: step.fields.filter((field) =>
      visiblePlacementIds.has(field.placementId.toLowerCase()),
    ),
  }));
  return { ...loaded, scope, recordType: authority.value.recordType, steps };
};

export async function advanceGuidedFormStepAction(
  request: GuidedFormStepRequest,
): Promise<GuidedFormStepActionResult> {
  const parsedRequest = stepRequestSchema.safeParse(request);
  if (!parsedRequest.success) return { kind: "unavailable" };
  const input = parsedRequest.data;
  const loaded = await requestMetadata(await loadActionPage(input.address));
  if (loaded.kind !== "available") return loaded;
  const current = loaded.model.guidedForm!;
  if (
    input.expectedRevision !== current.revision ||
    !sameId(input.draftId, current.draftId)
  )
    return {
      kind: "conflict",
      activeStepId: current.computedStepId,
      computedStepId: current.computedStepId,
      revision: current.revision,
    };
  const computedIndex = loaded.steps.findIndex((step) => step.stepId === current.computedStepId);
  const stepIndex = loaded.steps.findIndex((step) => step.stepId === input.stepId);
  const step = loaded.steps[stepIndex];
  if (stepIndex < 0 || step === undefined || step.summary)
    return { kind: "unavailable" };
  if (stepIndex > computedIndex)
    return {
      kind: "unchanged",
      activeStepId: current.computedStepId,
      computedStepId: current.computedStepId,
      revision: current.revision,
    };
  const update = validateGuidedFormStep(
    loaded.recordType,
    step.fields,
    current.values,
    current.validation,
    input.values,
  );
  if (update === undefined) return { kind: "unavailable" };
  const service = createGuidedFormDraftService();
  const result = await service.update(loaded.session, loaded.selection, {
    ...loaded.scope,
    draftId: platformIdSchema.parse(current.draftId),
    expectedRevision: current.revision,
    values: update.values,
    validation: update.validation,
  });
  if (result.kind !== "available") return result;
  if (result.value.outcome === "stale_revision")
    return {
      kind: "conflict",
      activeStepId: current.computedStepId,
      computedStepId: current.computedStepId,
      revision: current.revision,
    };
  if (result.value.outcome !== "updated") return { kind: "unavailable" };
  const visibleValues = visibleGuidedFormValues(result.value.draft, loaded.steps);
  const visibleValidation = visibleGuidedFormValidation(result.value.draft.validation, loaded.steps);
  const computedStepId = computeGuidedFormStepId(loaded.steps, visibleValidation);
  if (computedStepId === undefined) return { kind: "unavailable" };
  return {
    kind: "updated",
    activeStepId: earlierGuidedStepId(loaded.steps, computedStepId, input.requestedStepId),
    computedStepId,
    revision: result.value.draft.revision,
    valid: update.valid,
  };
}

export async function confirmGuidedFormAction(
  request: GuidedFormConfirmRequest,
): Promise<GuidedFormConfirmResult> {
  const parsedRequest = confirmRequestSchema.safeParse(request);
  if (!parsedRequest.success) return { kind: "unavailable" };
  const input = parsedRequest.data;
  const loaded = await requestMetadata(await loadActionPage(input.address));
  if (loaded.kind !== "available") return loaded;
  const current = loaded.model.guidedForm!;
  const summary = loaded.steps.find((step) => step.summary);
  if (summary === undefined) return { kind: "unavailable" };
  if (
    input.stepId !== summary.stepId ||
    current.computedStepId !== summary.stepId ||
    input.expectedRevision !== current.revision ||
    !sameId(input.draftId, current.draftId)
  )
    return { kind: "conflict" };
  const service = createGuidedFormDraftService();
  const read = await service.read(loaded.session, loaded.selection, loaded.scope);
  if (read.kind !== "available") return read;
  if (
    read.value.outcome !== "available" ||
    !sameId(String(read.value.draft.draftId), current.draftId) ||
    read.value.draft.revision !== input.expectedRevision
  )
    return { kind: "conflict" };
  const validation = visibleGuidedFormValidation(read.value.draft.validation, loaded.steps);
  if (computeGuidedFormStepId(loaded.steps, validation) !== summary.stepId)
    return { kind: "conflict" };
  return {
    kind: "confirmed",
    values: visibleGuidedFormValues(read.value.draft, loaded.steps),
  };
}

export async function abandonGuidedFormDraftAction(
  request: GuidedFormAbandonRequest,
): Promise<Readonly<{ kind: "abandoned" | "conflict" | "unavailable" | "temporarily_unavailable" }>> {
  const parsedRequest = abandonRequestSchema.safeParse(request);
  if (!parsedRequest.success) return { kind: "unavailable" };
  const input = parsedRequest.data;
  const address = input.address;
  const identity = continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  const resolved = await resolveApplicationAddress(
    identity.session,
    address.tenantShortName,
    address.organizationShortName,
    address.applicationKey,
    address.pageKey,
  );
  if (resolved.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  if (resolved.kind !== "application_page") return { kind: "unavailable" };
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId: resolved.read.organizationId,
    applicationRootId: resolved.application.applicationRootId,
  });
  const result = await createGuidedFormDraftService().abandon(identity.session, selection, {
    draftId: input.draftId,
    expectedRevision: input.expectedRevision,
  });
  if (result.kind !== "available") return result;
  return result.value.outcome === "abandoned" ? { kind: "abandoned" } : { kind: "conflict" };
}

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
