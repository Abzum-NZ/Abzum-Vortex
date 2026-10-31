import { workflowValueTypeSchema } from "../catalogue/catalogues";
import { flowTaskChildLists, type FlowTask } from "../workflows/flow-contracts";
import type { FlowValue } from "../workflows/flow-values";

/**
 * The closed settings of steps and bindings, checked at publication: the values each setting may
 * take. A value outside the closed set is refused by name, so nothing publishes that the page or
 * the server would ignore.
 */

/** Where a message shows. `dialog` blocks until read; the others are part of the page. */
export const flowMessageTargets = ["dialog", "toast", "banner", "inline", "slot"] as const;
export type FlowMessageTarget = (typeof flowMessageTargets)[number];
export const flowMessageSeverities = ["info", "success", "warning", "error"] as const;
export type FlowMessageSeverity = (typeof flowMessageSeverities)[number];
/** The shortest and longest auto-dismiss a message may carry, in milliseconds. */
export const flowMessageDismissBounds = Object.freeze({ minimumMs: 2_000, maximumMs: 30_000 });

export type FlowStepSettingIssue = Readonly<{
  path: (string | number)[];
  message: string;
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
  const invalid = (path: (string | number)[], message: string) => issues.push({ path, message });
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
      const dismiss = properties.dismiss_after_ms;
      if (dismiss !== undefined) {
        const milliseconds = dismiss.kind === "literal" ? dismiss.literal.value : undefined;
        if (
          dismiss.kind !== "literal" ||
          dismiss.literal.type !== "whole_number" ||
          typeof milliseconds !== "number" ||
          !Number.isInteger(milliseconds) ||
          milliseconds < flowMessageDismissBounds.minimumMs ||
          milliseconds > flowMessageDismissBounds.maximumMs
        )
          invalid(
            [...path, "dismiss_after_ms"],
            "Show message: auto-dismiss must be a literal between 2,000 and 30,000 milliseconds",
          );
        if (
          (target !== "toast" && target !== "banner") ||
          (severity !== "info" && severity !== "success")
        )
          invalid(
            [...path, "dismiss_after_ms"],
            "Show message: auto-dismiss is available only for an info or success toast or banner",
          );
      }
      if ((properties.action_label === undefined) !== (properties.action_flow === undefined))
        invalid(
          [...path, "action_label"],
          "Show message: an action needs both its label and its flow",
        );
    } else if (type === "interface.clear_message") checkTarget(properties, path, "Clear message");
    else if (type === "interface.set_value") {
      const page = properties.value !== undefined;
      const form = properties.form !== undefined;
      const field = properties.field !== undefined;
      if ((page && (form || field)) || (!page && !(form && field)))
        invalid(path, "Set value: choose either a page value or both a form and field");
      for (const key of ["value", "form", "field"] as const)
        if (properties[key] !== undefined && literalText(properties[key]) === undefined)
          invalid([...path, key], `Set value: ${key} must be a literal`);
    } else if (type === "backend.run") {
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
