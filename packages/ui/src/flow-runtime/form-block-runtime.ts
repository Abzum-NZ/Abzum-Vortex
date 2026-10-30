import type { FlowRuntime, PlacementFlowBinding } from "./flow-runtime";
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
type PreparedForm = Readonly<{
  values: FormFieldAnswers;
  selectedOwnerGroupId?: string;
  recordChanges?: readonly string[];
}>;

export type FormBlockRuntime = Readonly<{
  /** One form_submit gesture: dispatch the bound flow under its concurrency setting. */
  submit: (
    binding: PlacementFlowBinding,
    /** Builds the submission once, after the form's pending changes have settled. */
    prepare: (signal: AbortSignal) => PreparedForm | undefined | Promise<PreparedForm | undefined>,
    gestureId: string,
    sourceTablePlacementId?: string,
  ) => Promise<ServerDrivenResult | undefined>;
  /** The form's mount event, when the placement binds it. */
  ready: (
    binding: PlacementFlowBinding,
    gestureId: string,
  ) => Promise<ServerDrivenResult | undefined>;
  /** The form's reset event, when the placement binds it. */
  reset: (
    binding: PlacementFlowBinding,
    gestureId: string,
  ) => Promise<ServerDrivenResult | undefined>;
}>;

export function createFormBlockRuntime(runtime: FlowRuntime): FormBlockRuntime {
  const dispatchOnce = (
    binding: PlacementFlowBinding,
    callerInputs:
      | Readonly<Record<string, unknown>>
      | ((signal: AbortSignal) => Promise<Readonly<Record<string, unknown>> | undefined>),
    gestureId: string,
    sourceTablePlacementId?: string,
  ): Promise<ServerDrivenResult | undefined> =>
    runtime.dispatch(binding, callerInputs, gestureId, undefined, sourceTablePlacementId);

  return Object.freeze({
    submit: (binding, prepare, gestureId, sourceTablePlacementId) => {
      if (binding.event !== "form_submit") return Promise.resolve(undefined);
      return dispatchOnce(
        binding,
        async (signal) => {
          const submission = await prepare(signal);
          return submission === undefined
            ? undefined
            : {
                values: submission.values,
                ...(submission.recordChanges === undefined
                  ? {}
                  : { recordChanges: submission.recordChanges }),
                ...(submission.selectedOwnerGroupId === undefined
                  ? {}
                  : { selectedOwnerGroupId: submission.selectedOwnerGroupId }),
              };
        },
        gestureId,
        sourceTablePlacementId,
      );
    },
    ready: (binding, gestureId) =>
      binding.event === "form_ready"
        ? dispatchOnce(binding, {}, gestureId)
        : Promise.resolve(undefined),
    reset: (binding, gestureId) =>
      binding.event === "form_reset"
        ? dispatchOnce(binding, {}, gestureId)
        : Promise.resolve(undefined),
  });
}
