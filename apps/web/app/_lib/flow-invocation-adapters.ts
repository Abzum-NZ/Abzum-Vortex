import "server-only";

import type { FlowInvocationAdapters, FlowInvocationRequest } from "@web/platform-server";
import {
  getGuidedFormControlIds,
  getGuidedFormFlowId,
  guidedFormConfirmationKey,
  guidedFormConfirmationReference,
  verifiesGuidedFormConfirmation,
} from "./guided-form-steps";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { appTelemetry } from "./server-composition";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { getQueryContinuationKey } from "./query-continuation-key";
import { loadApplicationPage, loadProjectedReferenceChoiceForm } from "./application-page";
import { applicationHasAuthoredForm, resolveReferenceChoiceFormValues } from "./reference-choices";
import type { resolveApplicationAddress } from "./application-address";

type Address = Extract<
  Awaited<ReturnType<typeof resolveApplicationAddress>>,
  { kind: "application_page" }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Page projection stays in web; the platform invocation decides when it must be rechecked. */
export const flowInvocationAdapters = (
  address: Address,
  body: FlowInvocationRequest,
): FlowInvocationAdapters => ({
  authorityId: getIdentityAuthorityConfiguration().authorityId,
  telemetry: appTelemetry,
  releaseCatalogue: installedReleaseCatalogue,
  continuationKey: getQueryContinuationKey(),
  guidedFormControls: getGuidedFormControlIds,
  guidedFormFlowId: getGuidedFormFlowId,
  confirmationKey: guidedFormConfirmationKey,
  confirmationReference: guidedFormConfirmationReference,
  verifiesConfirmation: verifiesGuidedFormConfirmation,
  hasAuthoredForm: applicationHasAuthoredForm,
  projectForm: (session, request) => loadProjectedReferenceChoiceForm(session, address, request),
  resolveFormValues: resolveReferenceChoiceFormValues,
  verifyGuidedPage: async ({ session, guided, subject, binding, reference, invocation }) => {
    const page = await loadApplicationPage(
      session,
      {
        tenantShortName: body.tenantShortName,
        organizationShortName: body.organizationShortName,
        read: address.read,
        application: address.application,
        pageKey: guided.pageKey,
      },
      subject === undefined ? {} : { record_id: subject.recordId },
    );
    if (page.kind !== "available") return undefined;
    const model = page.model;
    const draft = model.guidedForm;
    const summary = Array.isArray(model.page.steps)
      ? model.page.steps.find((step) => isRecord(step) && step.summary === true)
      : undefined;
    if (
      draft === undefined ||
      summary === undefined ||
      guided.flowId === undefined ||
      String(model.pageId).toLowerCase() !== guided.pageId.toLowerCase() ||
      !isRecord(summary) ||
      typeof summary.id !== "string" ||
      draft.computedStepId !== summary.id ||
      model.invocation.installationRevision !== invocation.installationRevision ||
      model.invocation.releaseKey !== invocation.releaseKey ||
      draft.draftId.toLowerCase() !== reference.draftId.toLowerCase() ||
      draft.revision !== reference.revision ||
      draft.flowId.toLowerCase() !== guided.flowId.toLowerCase() ||
      (model.subject?.recordId.toLowerCase() ?? null) !==
        (subject?.recordId.toLowerCase() ?? null) ||
      (subject !== undefined && model.subject?.revision !== subject.revision) ||
      !(model.bindings[binding.controlId] ?? []).some(
        (held) =>
          held.event === "form_submit" &&
          held.bindingId.toLowerCase() === String(binding.bindingId).toLowerCase(),
      )
    )
      return undefined;
    return draft.values;
  },
});
