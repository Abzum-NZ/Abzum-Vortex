import { equalFormValue, type FlowInvokeClient, type ServerFlowResponse } from "@vortex/ui";
import type { SubmittedForm } from "./types";
import type { useFlowRuntime } from "./use-flow-runtime";

type Tracking = Pick<
  Parameters<typeof useFlowRuntime>[0],
  "continuingFormsRef" | "formCancelledRef" | "unsavedWorkRegistry" | "controlDraftsRef"
> &
  Readonly<{ submissions: Map<string, SubmittedForm> }>;

/** Track form submissions through the existing invocation and continuation client. */
export function trackFlowInvokeClient(
  client: FlowInvokeClient,
  {
    submissions,
    continuingFormsRef,
    formCancelledRef,
    unsavedWorkRegistry,
    controlDraftsRef,
  }: Tracking,
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
      const store = controlDraftsRef?.current;
      if (store === undefined) return;
      for (const [id, draft] of Object.entries(store.drafts))
        if (
          draft.owner === submission.formId &&
          Object.hasOwn(submission.values, draft.fieldKey) &&
          equalFormValue(draft.value, submission.values[draft.fieldKey])
        ) {
          delete store.drafts[id];
        }
      if (Object.values(store.drafts).some((draft) => draft.owner === submission.formId))
        store.baselines[submission.formId] = submission.values;
      else {
        delete store.baselines[submission.formId];
        delete store.baselineFields[submission.formId];
      }
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
      const response = await client.startBinding(
        binding,
        callerInputs,
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
      bindingId,
    ) => {
      if (answer.kind === "cancel") formCancelledRef.current = true;
      const submission = continuingFormsRef.current.get(continuation);
      const response = await client.resume(
        flowId,
        continuation,
        answer,
        evidence,
        signal,
        sourceTablePlacementId,
        carriedValues,
        bindingId,
      );
      if (response.kind !== "unknown") continuingFormsRef.current.delete(continuation);
      recordResponse(response, submission);
      return response;
    },
  };
}
