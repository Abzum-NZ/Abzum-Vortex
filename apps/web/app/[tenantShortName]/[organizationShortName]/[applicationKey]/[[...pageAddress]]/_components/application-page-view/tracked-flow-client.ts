import type { FlowInvokeClient, ServerFlowResponse } from "@vortex/ui";
import type { SubmittedForm } from "./types";
import type { useFlowRuntime } from "./use-flow-runtime";

type Tracking = Pick<
  Parameters<typeof useFlowRuntime>[0],
  "continuingFormsRef" | "formCancelledRef" | "unsavedWorkRegistry"
> &
  Readonly<{ submissions: Map<string, SubmittedForm> }>;

/** Track form submissions through the existing invocation and continuation client. */
export function trackFlowInvokeClient(
  client: FlowInvokeClient,
  { submissions, continuingFormsRef, formCancelledRef, unsavedWorkRegistry }: Tracking,
): FlowInvokeClient {
  const recordResponse = (response: ServerFlowResponse, submission: SubmittedForm | undefined) => {
    if (submission === undefined) return;
    if (response.kind === "intent") {
      continuingFormsRef.current.set(response.continuation, submission);
    } else if (
      response.kind === "result" &&
      response.failure === undefined &&
      response.descriptor.commit === "confirmed"
    ) {
      // The server has confirmed the submitted values before its Navigate intent is presented.
      unsavedWorkRegistry?.markSaved(submission.formId, submission.values);
    }
  };
  return {
    openRun: (...args) => client.openRun(...args),
    startBinding: async (
      binding,
      callerInputs,
      clickId,
      signal,
      gestureSubject,
      sourceTablePlacementId,
      carriedValues,
      segmentValues,
    ) => {
      const submission = submissions.get(clickId);
      const inputs =
        submission?.choiceEvidence === undefined
          ? callerInputs
          : { ...callerInputs, choiceEvidence: submission.choiceEvidence };
      const response = await client.startBinding(
        binding,
        inputs,
        clickId,
        signal,
        gestureSubject,
        sourceTablePlacementId,
        carriedValues,
        segmentValues,
      );
      recordResponse(response, submission);
      return response;
    },
    resume: async (
      flowId,
      continuation,
      answer,
      evidence,
      signal,
      sourceTablePlacementId,
      carriedValues,
    ) => {
      if (answer.kind === "cancel") formCancelledRef.current = true;
      const submission = continuingFormsRef.current.get(continuation);
      continuingFormsRef.current.delete(continuation);
      const response = await client.resume(
        flowId,
        continuation,
        answer,
        evidence,
        signal,
        sourceTablePlacementId,
        carriedValues,
      );
      recordResponse(response, submission);
      return response;
    },
  };
}
