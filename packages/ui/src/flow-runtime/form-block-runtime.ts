import type { ComponentFlowBinding } from "@vortex/platform/schema";
import type { FlowRuntime } from "./flow-runtime";
import type { ServerDrivenResult } from "./server-driven-run";

/**
 * The form block's wiring to the page's flow runtime. A form container emits one
 * `form_submit` for a gesture (a Submit click or Enter in a field); this module turns that gesture
 * into exactly one `FlowRuntime.dispatch` of the flow bound to it. The shared runtime applies the
 * binding's concurrency setting, and the gesture identity is passed to the server so a retry of
 * the same request reaches the same run instead of committing again.
 *
 * The surface's field answers and optional owner Group choice travel as the submission envelope
 * the server's form-submit adapter reads; the client never names a flow input, a node or an outcome.
 */

export type FormFieldAnswers = Readonly<Record<string, unknown>>;

export type FormBlockRuntime = Readonly<{
  /** One form_submit gesture: dispatch the bound flow under its concurrency setting. */
  submit: (
    binding: ComponentFlowBinding,
    values: FormFieldAnswers,
    selectedOwnerGroupId?: string,
    /** Names included in the whole-record patch; individual answers remain complete. */
    recordChanges?: readonly string[],
  ) => Promise<ServerDrivenResult | undefined>;
  /** The form's mount event, when the placement binds it. */
  ready: (binding: ComponentFlowBinding) => Promise<ServerDrivenResult | undefined>;
  /** The form's reset event, when the placement binds it. */
  reset: (binding: ComponentFlowBinding) => Promise<ServerDrivenResult | undefined>;
}>;

/**
 * Whether the server's answer is unknown, so the same request may be sent again under the same
 * gesture identity: the request failed or the server could not answer. Every other result is the
 * server's definitive answer for that gesture.
 */
const outcomeUnknown = (result: ServerDrivenResult): boolean =>
  result.kind === "unavailable" || result.kind === "abandoned";

export function createFormBlockRuntime(
  runtime: FlowRuntime,
  newGestureId: () => string = () => crypto.randomUUID(),
): FormBlockRuntime {
  // The gesture identity of a submission whose outcome is still unknown, keyed by the binding and
  // the exact answers it carried. Sending the same answers again (a retry after a failed request)
  // reaches the same run, so the effect ledger replays its outcome instead of committing twice.
  // Once the server has answered definitively the identity is released: submitting again is a new
  // gesture, even with the same answers.
  const unsettled = new Map<string, string>();

  const dispatchOnce = async (
    binding: ComponentFlowBinding,
    callerInputs: Readonly<Record<string, unknown>>,
    retryKey?: string,
  ): Promise<ServerDrivenResult | undefined> => {
    const gestureId =
      (retryKey === undefined ? undefined : unsettled.get(retryKey)) ?? newGestureId();
    let unknown = true;
    try {
      const result = await runtime.dispatch(binding, callerInputs, gestureId);
      unknown = outcomeUnknown(result);
      return result;
    } finally {
      if (retryKey !== undefined) {
        if (unknown) unsettled.set(retryKey, gestureId);
        else unsettled.delete(retryKey);
      }
    }
  };

  return Object.freeze({
    submit: (binding, values, selectedOwnerGroupId, recordChanges) => {
      if (binding.event !== "form_submit") return Promise.resolve(undefined);
      const callerInputs = {
        values,
        ...(recordChanges === undefined ? {} : { recordChanges }),
        ...(selectedOwnerGroupId === undefined ? {} : { selectedOwnerGroupId }),
      };
      return dispatchOnce(
        binding,
        callerInputs,
        `${binding.bindingId}|${JSON.stringify(callerInputs)}`,
      );
    },
    ready: (binding) =>
      binding.event === "form_ready" ? dispatchOnce(binding, {}) : Promise.resolve(undefined),
    reset: (binding) =>
      binding.event === "form_reset" ? dispatchOnce(binding, {}) : Promise.resolve(undefined),
  });
}
