import type { ComponentFlowBinding } from "@vortex/contracts";
import type { FlowDispatchResult, FlowRuntime } from "./flow-runtime";

/**
 * #588: the form block's wiring to the browser flow runtime (#1013). A form container emits one
 * `form_submit` for a gesture (a Submit click or Enter in a field); this module turns that gesture
 * into exactly one `FlowRuntime.dispatch` of the flow bound to it. While a dispatch is in flight a
 * second event for the same placement is ignored, so a double click cannot start the same run
 * twice, and the one gesture identity is passed to the server so a repeat reaches the same run and
 * the effect ledger replays its recorded outcome instead of committing again.
 *
 * The surface's answers travel as the submission envelope the server's form-submit adapter reads
 * (`values`, plus the exact #587 draft revision when the surface holds one); the client never
 * names a flow input, a node or an outcome.
 */

export type FormFieldAnswers = Readonly<Record<string, unknown>>;

/** The exact #587 private draft a submission's answers were read from. */
export type FormDraftEvidence = Readonly<{ draftId: string; revision: number }>;

export type FormBlockRuntime = Readonly<{
  /** One form_submit gesture: dispatch the bound flow once, or nothing when already in flight. */
  submit: (
    binding: ComponentFlowBinding,
    values: FormFieldAnswers,
    draft?: FormDraftEvidence,
  ) => Promise<FlowDispatchResult | undefined>;
  /** The form's mount event, when the placement binds it. */
  ready: (binding: ComponentFlowBinding) => Promise<FlowDispatchResult | undefined>;
  /** The form's reset event, when the placement binds it. */
  reset: (binding: ComponentFlowBinding) => Promise<FlowDispatchResult | undefined>;
}>;

export function createFormBlockRuntime(
  runtime: FlowRuntime,
  newGestureId: () => string = () => crypto.randomUUID(),
): FormBlockRuntime {
  const inFlight = new Set<string>();
  // A submission's one gesture identity, keyed by the binding and the exact answers it carries.
  // Re-submitting the same answers (a double click that outlived the first run, or a network
  // retry) reaches the same run, so the effect ledger replays its recorded outcome instead of
  // committing a second time. A changed answer set is a new gesture.
  const gestureIds = new Map<string, string>();

  const dispatchOnce = async (
    binding: ComponentFlowBinding,
    callerInputs: Readonly<Record<string, unknown>>,
    gestureKey?: string,
  ): Promise<FlowDispatchResult | undefined> => {
    const guard = gestureKey ?? binding.bindingId;
    if (inFlight.has(guard)) return undefined;
    let gestureId = gestureKey === undefined ? undefined : gestureIds.get(gestureKey);
    if (gestureId === undefined) {
      gestureId = newGestureId();
      if (gestureKey !== undefined) gestureIds.set(gestureKey, gestureId);
    }
    inFlight.add(guard);
    try {
      return await runtime.dispatch(binding, callerInputs, gestureId);
    } finally {
      inFlight.delete(guard);
    }
  };

  return Object.freeze({
    submit: (binding, values, draft) => {
      if (binding.event !== "form_submit") return Promise.resolve(undefined);
      const callerInputs = { values, ...(draft === undefined ? {} : { draft }) };
      return dispatchOnce(
        binding,
        callerInputs,
        `${binding.bindingId}|${JSON.stringify(callerInputs)}`,
      );
    },
    ready: (binding) =>
      binding.event === "form_ready"
        ? dispatchOnce(binding, {})
        : Promise.resolve(undefined),
    reset: (binding) =>
      binding.event === "form_reset"
        ? dispatchOnce(binding, {})
        : Promise.resolve(undefined),
  });
}
