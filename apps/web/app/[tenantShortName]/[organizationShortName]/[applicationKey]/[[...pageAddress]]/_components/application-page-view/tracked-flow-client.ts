import { equalFormValue, type FlowInvokeClient, type ServerFlowResponse } from "@vortex/ui";
import type { SubmittedForm } from "./types";
import type { useFlowRuntime } from "./use-flow-runtime";

type Tracking = Pick<
  Parameters<typeof useFlowRuntime>[0],
  "unsavedWorkRegistry" | "controlDraftsRef"
> &
  Readonly<{ submissions: Map<string, SubmittedForm> }>;

/** Track form submissions through the invocation client. */
export function trackFlowInvokeClient(
  client: FlowInvokeClient,
  { submissions, unsavedWorkRegistry, controlDraftsRef }: Tracking,
): FlowInvokeClient {
  const recordResponse = (response: ServerFlowResponse, submission: SubmittedForm | undefined) => {
    if (submission === undefined) return;
    if (
      response.kind === "result" &&
      response.failure === undefined &&
      (response.descriptor.commit === "confirmed" || submission.draftSaved === true)
    ) {
      // The server has confirmed the submitted values (a record, or a guided step's draft) before
      // its Navigate intent is presented.
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
  };
}
