import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { isRecord } from "../catalogue/runtime-primitives";
import type { FlowProtectedTaskCall, FlowTaskOutcome } from "../rules/flow-interpreter";
import { reportUnexpectedFailure } from "./definition-error";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";
import { carriesSensitive } from "./flow-orchestrator-support";

type GuidedDrafts = NonNullable<FlowOrchestratorDependencies["guidedDrafts"]>;

/** Runs a Save or Discard guided-form draft task through the draft port. */
export const runGuidedDraftTask = async (
  drafts: GuidedDrafts,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  call: FlowProtectedTaskCall,
  sensitive: readonly string[],
): Promise<{ outcome: FlowTaskOutcome; outputs?: Record<string, string | number | boolean> }> => {
  const draftId = call.properties.draft_id?.value;
  const revision = call.properties.revision?.value;
  if (
    typeof draftId !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision)
  )
    return { outcome: "validation" };
  try {
    if (call.taskType === "form.discard_draft") {
      const discarded = await drafts.discard(session, selection, { draftId, revision });
      if (discarded.outcome === "discarded") return { outcome: "completed", outputs: {} };
      return { outcome: discarded.outcome === "conflict" ? "conflict" : "refused" };
    }
    const step = call.properties.step?.value;
    const requested = call.properties.requested_step?.value;
    const values = call.properties.values?.value;
    if (
      typeof step !== "string" ||
      (requested !== undefined && typeof requested !== "string") ||
      !isRecord(values) ||
      carriesSensitive(values, sensitive)
    )
      return { outcome: "validation" };
    const saved = await drafts.save(session, selection, {
      draftId,
      revision,
      step,
      ...(requested === undefined ? {} : { requestedStep: requested }),
      values,
    });
    if (saved.outcome === "saved")
      return {
        outcome: "completed",
        outputs: { step_id: saved.stepId, revision: saved.revision, valid: saved.valid },
      };
    return { outcome: saved.outcome === "conflict" ? "conflict" : "refused" };
  } catch (error) {
    reportUnexpectedFailure("guided form draft task", error);
    return { outcome: "failed" };
  }
};
