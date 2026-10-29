import type { FormContinuationAnswer, PageStepType } from "@vortex/platform/schema";
import {
  confirmAnswer,
  performPresentationIntent,
  readConfirmIntent,
  readFormIntent,
  type FlowIntent,
  type FlowIntentHost,
  type FlowIntentKind,
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

/** Every step marked runs.page in the registry has an implementation here. */
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
} satisfies Record<PageStepType, PageStepImplementation>;

const implementationByIntent = {
  show_message: pageStepImplementations["interface.show_message"],
  show_form: pageStepImplementations["interface.show_form"],
  confirm: pageStepImplementations["interface.confirm"],
  navigate: pageStepImplementations["interface.navigate"],
  refresh: pageStepImplementations["interface.refresh"],
  set_panel: pageStepImplementations["interface.set_panel"],
  set_filter: pageStepImplementations["interface.set_filter"],
} satisfies Record<FlowIntentKind, PageStepImplementation>;

/** The same page implementations handle both local steps and server-returned intents. */
export const performPageFlowIntent: PageStepImplementation = (intent, host, signal) =>
  implementationByIntent[intent.kind](intent, host, signal);
