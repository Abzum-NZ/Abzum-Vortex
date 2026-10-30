import "server-only";

import {
  computeGuidedFormStepId,
  createGuidedFormDraftService,
  earlierGuidedStepId,
  validateGuidedFormStep,
  visibleGuidedFormValidation,
  type BoundHumanOrganizationRequest,
  type FlowGuidedDraftPort,
} from "@vortex/platform/server";
import {
  platformIdSchema,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { guidedFormDependencies } from "../guided-form-dependencies";
import { loadGuidedConfirmation } from "./guided-confirmation";
import type { ApplicationPageLoaderAddress } from "./types";

/**
 * The guided-form draft steps of one guided page, for the flow runner: the page is projected for
 * the caller (so only their own draft is found), and a step is saved or a draft removed only when
 * the draft is that one at the revision the flow names.
 */
export const createGuidedDraftPort = (
  address: ApplicationPageLoaderAddress,
  guided: Readonly<{ pageKey: string; pageId: string }>,
  subject: Readonly<{ recordId: string }> | undefined,
  boundRequest: BoundHumanOrganizationRequest | undefined,
): FlowGuidedDraftPort => {
  const dependencies = guidedFormDependencies(boundRequest);
  const loadOwn = async (session: IdentitySession, draftId: string, revision: number) => {
    const loaded = await loadGuidedConfirmation(session, address, guided, subject, boundRequest);
    const current = loaded?.guidedForm;
    if (loaded === undefined || current === undefined) return { outcome: "unavailable" as const };
    if (current.draftId.toLowerCase() !== draftId.toLowerCase())
      return { outcome: "refused" as const };
    if (current.revision !== revision) return { outcome: "conflict" as const };
    return { outcome: "loaded" as const, loaded, current };
  };
  return {
    async save(session, selection, input) {
      const own = await loadOwn(session, input.draftId, input.revision);
      if (own.outcome !== "loaded") return own;
      const { loaded, current } = own;
      const computedIndex = loaded.steps.findIndex(
        (step) => step.stepId === current.computedStepId,
      );
      const stepIndex = loaded.steps.findIndex((step) => step.stepId === input.step);
      const step = loaded.steps[stepIndex];
      if (step === undefined || step.summary || stepIndex > computedIndex)
        return { outcome: "refused" };
      const update = validateGuidedFormStep(
        loaded.recordType,
        step.fields,
        current.values,
        current.validation,
        input.values as Readonly<Record<string, JsonValue>>,
      );
      if (update === undefined) return { outcome: "refused" };
      const result = await createGuidedFormDraftService(dependencies).update(
        session,
        selection as OrganizationSelectionCandidate,
        {
          ...loaded.scope,
          draftId: platformIdSchema.parse(current.draftId),
          expectedRevision: current.revision,
          values: update.values,
          validation: update.validation,
        },
      );
      if (result.kind !== "available") return { outcome: "unavailable" };
      if (result.value.outcome === "stale_revision") return { outcome: "conflict" };
      if (result.value.outcome !== "updated") return { outcome: "refused" };
      const computed = computeGuidedFormStepId(
        loaded.steps,
        visibleGuidedFormValidation(result.value.draft.validation, loaded.steps),
      );
      if (computed === undefined) return { outcome: "unavailable" };
      return {
        outcome: "saved",
        stepId: earlierGuidedStepId(
          loaded.steps,
          computed,
          input.requestedStep === "" ? undefined : input.requestedStep,
        ),
        revision: result.value.draft.revision,
        valid: update.valid,
      };
    },
    async discard(session, selection, input) {
      const own = await loadOwn(session, input.draftId, input.revision);
      if (own.outcome !== "loaded") return own;
      const result = await createGuidedFormDraftService(dependencies).abandon(session, selection, {
        draftId: platformIdSchema.parse(own.current.draftId),
        expectedRevision: own.current.revision,
      });
      if (result.kind !== "available") return { outcome: "unavailable" };
      return { outcome: result.value.outcome === "abandoned" ? "discarded" : "conflict" };
    },
  };
};
