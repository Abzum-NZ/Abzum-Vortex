import type { FormContinuationAnswer, PageIntentStepType } from "@vortex/platform/schema";
import {
  confirmAnswer,
  performPresentationIntent,
  readConfirmIntent,
  readFormIntent,
  type FlowIntent,
  type FlowIntentHost,
} from "./intents";

type PageStepImplementation = (
  intent: FlowIntent,
  host: FlowIntentHost,
  signal?: AbortSignal,
) => Promise<FormContinuationAnswer | undefined>;

const presentation: PageStepImplementation = async (intent, host, signal) => {
  await performPresentationIntent(intent, host, signal);
  return undefined;
};

/** Registered page steps have an intent implementation; the interpreter handles control steps. */
const pageStepImplementations = {
  "interface.show_message": presentation,
  "interface.show_form": async (intent, host, signal) => {
    const form = readFormIntent(intent);
    return form === undefined ? undefined : host.showForm(form, signal);
  },
  "interface.confirm": async (intent, host, signal) => {
    const confirmation = readConfirmIntent(intent);
    return confirmation === undefined
      ? undefined
      : confirmAnswer(confirmation, await host.confirm(confirmation, signal));
  },
  "interface.navigate": presentation,
  "interface.refresh": presentation,
  "interface.set_panel": presentation,
  "interface.set_filter": presentation,
} satisfies Record<PageIntentStepType, PageStepImplementation>;

/** The same page implementations handle both local steps and server-returned intents. */
export const performPageFlowIntent: PageStepImplementation = (intent, host, signal) => {
  const implementation = pageStepImplementations[`interface.${intent.kind}` as PageIntentStepType];
  if (implementation === undefined) throw new Error("FLOW_PAGE_STEP_UNAVAILABLE");
  return implementation(intent, host, signal);
};
