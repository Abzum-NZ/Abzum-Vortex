import { workflowValueTypeSchema } from "../catalogue/catalogues";
import { flowTaskChildLists, type FlowTask } from "../workflows/flow-contracts";
import type { FlowValue } from "../workflows/flow-values";
import {
  componentEventBindingDefaults,
  type ComponentSemanticEventKind,
  type FlowBindingSettings,
} from "./component-semantic-events";

/**
 * The closed settings of contract 4's steps and bindings, checked at publication: the values each
 * setting may take, and the ones whose runtime has not landed yet. A setting that does not run yet
 * is refused by name, so nothing publishes that the page or the server would ignore; the batch that
 * lands its runtime removes the refusal.
 */

/** Where a message shows. `dialog` blocks until read; the others are part of the page. */
const flowMessageTargets = ["dialog", "toast", "banner", "inline", "slot"] as const;
const flowMessageSeverities = ["info", "success", "warning", "error"] as const;
/** The message targets the page shows today. */
const runnableMessageTargets: ReadonlySet<string> = new Set(["dialog"]);

export type FlowStepSettingIssue = Readonly<{
  path: (string | number)[];
  message: string;
  /** True when the value is valid contract but does not run yet. */
  notYetRunnable: boolean;
}>;

const literalText = (value: FlowValue | undefined): string | undefined =>
  value?.kind === "literal" && typeof value.literal.value === "string"
    ? value.literal.value
    : undefined;

/** Every step-setting problem in a flow's tasks, error handlers and finally tasks. */
export const flowStepSettingIssues = (
  flow: Readonly<{
    tasks: readonly FlowTask[];
    errors: readonly FlowTask[];
    finally: readonly FlowTask[];
  }>,
): FlowStepSettingIssue[] => {
  const issues: FlowStepSettingIssue[] = [];
  const invalid = (path: (string | number)[], message: string) =>
    issues.push({ path, message, notYetRunnable: false });
  const notYet = (path: (string | number)[], message: string) =>
    issues.push({ path, message, notYetRunnable: true });
  const visit = (tasks: readonly FlowTask[], base: (string | number)[]) =>
    tasks.forEach((task, index) => {
      const path = [...base, index];
      const properties = (task as { properties?: Readonly<Record<string, FlowValue>> }).properties;
      if (properties !== undefined) checkStep(task.type, properties, [...path, "properties"]);
      for (const child of flowTaskChildLists(task)) visit(child.tasks, [...path, ...child.path]);
    });
  const checkTarget = (
    properties: Readonly<Record<string, FlowValue>>,
    path: (string | number)[],
    step: string,
  ): string | undefined => {
    const target = literalText(properties.target);
    if (target === undefined || !(flowMessageTargets as readonly string[]).includes(target)) {
      invalid(
        [...path, "target"],
        `${step}: choose where it shows (${flowMessageTargets.join(", ")})`,
      );
      return undefined;
    }
    const placed = target === "inline" || target === "slot";
    if (placed !== (properties.component !== undefined))
      invalid(
        [...path, "component"],
        placed
          ? `${step}: name the component the message shows ${target === "inline" ? "under" : "in"}`
          : `${step}: only an inline or slot message names a component`,
      );
    return target;
  };
  const checkStep = (
    type: string,
    properties: Readonly<Record<string, FlowValue>>,
    path: (string | number)[],
  ) => {
    if (type === "interface.show_message") {
      const target = checkTarget(properties, path, "Show message");
      const severity = literalText(properties.severity);
      if (
        severity === undefined ||
        !(flowMessageSeverities as readonly string[]).includes(severity)
      )
        invalid(
          [...path, "severity"],
          `Show message: choose its severity (${flowMessageSeverities.join(", ")})`,
        );
      if (target === "dialog" && properties.title === undefined)
        invalid([...path, "title"], "Show message: a dialog needs a title");
      if (target !== undefined && !runnableMessageTargets.has(target))
        notYet(
          [...path, "target"],
          `Show message: a ${target} message cannot show yet; use a dialog`,
        );
      if ((properties.action_label === undefined) !== (properties.action_flow === undefined))
        invalid(
          [...path, "action_label"],
          "Show message: an action needs both its label and its flow",
        );
      else if (properties.action_flow !== undefined)
        notYet([...path, "action_flow"], "Show message: a message action cannot run yet");
    } else if (type === "interface.clear_message") checkTarget(properties, path, "Clear message");
    else if (type === "backend.run") {
      const mode = literalText(properties.mode);
      if (mode !== "await" && mode !== "start")
        invalid([...path, "mode"], "Run on back end: choose await (use its outputs) or start");
    } else if (type === "data.calculate") {
      const resultType = literalText(properties.result_type);
      if (resultType === undefined || !workflowValueTypeSchema.safeParse(resultType).success)
        invalid([...path, "result_type"], "Calculate: declare the type of its result");
    }
  };
  visit(flow.tasks, ["tasks"]);
  visit(flow.errors, ["errors"]);
  visit(flow.finally, ["finally"]);
  return issues;
};

/**
 * The first binding setting that does not run yet, by name. Field changes honour their configured
 * debounce and the events dispatched through the shared flow runtime honour their concurrency
 * setting. Other debounce settings, page-wide exclusive scope and a non-default timeout still
 * need their runtime implementations. The plan check handles conditions that need the gate.
 */
const scheduledEvents = new Set<ComponentSemanticEventKind>([
  "action",
  "row_clicked",
  "row_action",
  "inline_edit",
  "row_edit",
  "card_moved",
  "card_added",
  "field_changed",
  "field_focus_lost",
  "form_ready",
  "form_reset",
  "form_submit",
]);

export const flowBindingSettingNotYetRunnable = (
  event: ComponentSemanticEventKind,
  settings: FlowBindingSettings,
): string | undefined => {
  const defaults = componentEventBindingDefaults[event];
  if (event !== "field_changed" && settings.debounceMs !== defaults.debounceMs)
    return `a debounce other than ${defaults.debounceMs} ms cannot run yet`;
  if (
    !scheduledEvents.has(event) &&
    settings.concurrency !== defaults.concurrency &&
    settings.concurrency !== "ignore_while_running"
  )
    return `${settings.concurrency === "latest_wins" ? "latest wins" : "queued starts"} cannot run yet`;
  if (settings.exclusive !== defaults.exclusive && settings.exclusive === "page")
    return "exclusive to the page cannot run yet";
  if (settings.timeoutMs !== defaults.timeoutMs)
    return "a timeout other than the default cannot run yet";
  return undefined;
};
