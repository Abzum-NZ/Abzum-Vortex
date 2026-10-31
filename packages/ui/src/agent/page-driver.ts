import type { JsonValue } from "@vortex/platform/schema";
import type { FlowDispatchResult } from "../flow-runtime/flow-runtime";
import type {
  FlowConfirmAnswer,
  FlowConfirmIntent,
  FlowIntent,
  FlowMessageIntent,
} from "../flow-runtime/intents";

/**
 * What the page steps an agent's run reaches mean for the page it acts on: where Navigate goes,
 * what Show message says and who answers a confirmation. On a screen they are the page's own; a
 * page with no screen gives them a meaning through a headless driver, so the same tools work there.
 */
export type PageDriver = Readonly<{
  navigate: (intent: FlowIntent) => boolean | Promise<boolean>;
  showMessage: (message: FlowMessageIntent, signal?: AbortSignal) => void | Promise<void>;
  confirm: (confirmation: FlowConfirmIntent, signal?: AbortSignal) => Promise<FlowConfirmAnswer>;
}>;

/**
 * One agent gesture on a control: the driver its runs use, and where each run's result is reported
 * so the agent's tool call can answer with what happened.
 */
export type AgentGesture = Readonly<{
  driver: PageDriver;
  /** A run of the gesture started; each start is followed by exactly one `settled`. */
  started: () => void;
  settled: (result: FlowDispatchResult) => void;
}>;

/** What a run told its agent through the driver: the pages it opened and the messages it showed. */
export type PageDriverRecord = Readonly<{
  navigated: readonly Readonly<Record<string, JsonValue>>[];
  messages: readonly Readonly<{ severity: string; text: string }>[];
}>;

/**
 * The in-process driver for a page with no screen. Navigate records the page the run opens and
 * answers that it went; Show message records the text; a confirmation is never assumed: it is the
 * explicit answer of `confirmWith`, and without one it is declined.
 */
export function createHeadlessPageDriver(
  confirmWith?: (
    confirmation: FlowConfirmIntent,
    signal?: AbortSignal,
  ) => Promise<FlowConfirmAnswer>,
): PageDriver & Readonly<{ record: () => PageDriverRecord }> {
  const navigated: Readonly<Record<string, JsonValue>>[] = [];
  const messages: Readonly<{ severity: string; text: string }>[] = [];
  return Object.freeze({
    navigate: (intent: FlowIntent) => {
      navigated.push(intent.properties);
      return true;
    },
    showMessage: (message: FlowMessageIntent) => {
      messages.push({ severity: message.severity, text: message.text });
    },
    confirm: (confirmation: FlowConfirmIntent, signal?: AbortSignal) =>
      confirmWith === undefined
        ? Promise.resolve({ confirmed: false })
        : confirmWith(confirmation, signal),
    record: () => ({ navigated: [...navigated], messages: [...messages] }),
  });
}
