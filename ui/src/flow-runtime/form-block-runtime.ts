import type { ComponentFlowBinding } from "@vortex/contracts";
import type { FlowDispatchResult, FlowRuntime } from "./flow-runtime";

/**
 * #588: the form block's wiring to the browser flow runtime (#1013). A form container emits one
 * `form_submit` for a gesture (a Submit click or Enter in a field); this module turns that gesture
 * into exactly one `FlowRuntime.dispatch` of the flow bound to it. While a dispatch for a binding
 * is in flight every further event for that binding is ignored, so a double click cannot start a
 * second run, and the gesture identity is passed to the server so a repeat of the same request
 * reaches the same run and the effect ledger replays its recorded outcome instead of committing
 * again.
 *
 * The surface's answers travel as the submission envelope the server's form-submit adapter reads
 * (`values`); the client never names a flow input, a node or an outcome.
 */

export type FormFieldAnswers = Readonly<Record<string, unknown>>;

export type FormBlockRuntime = Readonly<{
  /** One form_submit gesture: dispatch the bound flow once, or nothing when already in flight. */
  submit: (
    binding: ComponentFlowBinding,
    values: FormFieldAnswers,
  ) => Promise<FlowDispatchResult | undefined>;
  /** The form's mount event, when the placement binds it. */
  ready: (binding: ComponentFlowBinding) => Promise<FlowDispatchResult | undefined>;
  /** The form's reset event, when the placement binds it. */
  reset: (binding: ComponentFlowBinding) => Promise<FlowDispatchResult | undefined>;
}>;

/**
 * Whether the server's answer is unknown, so the same request may be sent again under the same
 * gesture identity: the request failed or the server could not answer. Every other result is the
 * server's definitive answer for that gesture.
 */
const outcomeUnknown = (result: FlowDispatchResult): boolean =>
  result.ranIn === "server" &&
  (result.result.kind === "unavailable" || result.result.kind === "abandoned");

export function createFormBlockRuntime(
  runtime: FlowRuntime,
  newGestureId: () => string = () => crypto.randomUUID(),
): FormBlockRuntime {
  const inFlight = new Set<string>();
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
  ): Promise<FlowDispatchResult | undefined> => {
    if (inFlight.has(binding.bindingId)) return undefined;
    const gestureId =
      (retryKey === undefined ? undefined : unsettled.get(retryKey)) ?? newGestureId();
    inFlight.add(binding.bindingId);
    let unknown = true;
    try {
      const result = await runtime.dispatch(binding, callerInputs, gestureId);
      unknown = outcomeUnknown(result);
      return result;
    } finally {
      inFlight.delete(binding.bindingId);
      if (retryKey !== undefined) {
        if (unknown) unsettled.set(retryKey, gestureId);
        else unsettled.delete(retryKey);
      }
    }
  };

  return Object.freeze({
    submit: (binding, values) => {
      if (binding.event !== "form_submit") return Promise.resolve(undefined);
      const callerInputs = { values };
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
