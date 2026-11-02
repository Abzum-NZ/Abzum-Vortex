import type { FormAnswer, PageIntentStepType } from "@vortex/platform/schema";
import {
  confirmAnswer,
  isBackAnswer,
  performPresentationIntent,
  readConfirmIntent,
  readFormIntent,
  readVerifyIntent,
  type FlowIntent,
  type FlowIntentHost,
} from "./intents";

/** What a waiting step answers: the person's answer, or that they went back a step. */
type PageStepAnswer = FormAnswer | Readonly<{ kind: "back" }>;
const wentBack: PageStepAnswer = { kind: "back" };

type PageStepImplementation = (
  intent: FlowIntent,
  host: FlowIntentHost,
  signal?: AbortSignal,
  /** The person may go back to the step before this one. */
  back?: boolean,
) => Promise<PageStepAnswer | undefined>;

const presentation: PageStepImplementation = async (intent, host, signal) => {
  await performPresentationIntent(intent, host, signal);
  return undefined;
};

/** Registered page steps have an intent implementation; the interpreter handles control steps. */
const pageStepImplementations = {
  "interface.show_message": presentation,
  "interface.clear_message": presentation,
  "interface.wizard": presentation,
  "interface.show_form": async (intent, host, signal, back) => {
    const form = readFormIntent(intent);
    if (form === undefined) return undefined;
    const answer = await host.showForm(back === true ? { ...form, back } : form, signal);
    return isBackAnswer(answer) ? wentBack : answer;
  },
  "interface.confirm": async (intent, host, signal, back) => {
    const confirmation = readConfirmIntent(intent);
    if (confirmation === undefined) return undefined;
    const answer = await host.confirm(
      back === true ? { ...confirmation, back } : confirmation,
      signal,
    );
    return isBackAnswer(answer) ? wentBack : confirmAnswer(confirmation, answer);
  },
  "interface.verify": async (intent, host, signal, back) => {
    const verification = readVerifyIntent(intent);
    if (verification === undefined) return undefined;
    if (host.verify === undefined) throw new Error("FLOW_VERIFY_UNAVAILABLE");
    const answer = await host.verify(
      back === true ? { ...verification, back } : verification,
      signal,
    );
    return isBackAnswer(answer) ? wentBack : { kind: "confirm", confirmed: answer.confirmed };
  },
  "interface.navigate": presentation,
  "interface.refresh": presentation,
  "interface.set_panel": presentation,
  "interface.set_filter": presentation,
  "interface.set_value": presentation,
  "interface.validate_form": presentation,
} satisfies Record<PageIntentStepType, PageStepImplementation>;

/** The same page implementations handle both local steps and server-returned intents. */
export const performPageFlowIntent: PageStepImplementation = (intent, host, signal, back) => {
  const implementation = pageStepImplementations[`interface.${intent.kind}` as PageIntentStepType];
  if (implementation === undefined) throw new Error("FLOW_PAGE_STEP_UNAVAILABLE");
  return implementation(intent, host, signal, back);
};
