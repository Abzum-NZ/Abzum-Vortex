import type { FlowTask } from "../workflows/flow-contracts";
import {
  flowVerificationRequirements,
  maximumFlowWizardSteps,
} from "../workflows/flow-confirmation-limits";
import type { FlowValue } from "../workflows/flow-values";

const literalOf = (value: FlowValue | undefined): unknown =>
  value?.kind === "literal" ? value.literal.value : undefined;

type Report = (name: string, message: string, missing?: boolean) => void;

/**
 * The rules of the guided-dialog steps that the registry's property types cannot state: a Verify
 * step asks for one known proof, a Guided steps step names a bounded list of steps and a current
 * step that is one of them, and a Navigate step names a page, or another application (by key or
 * by identity) to open at its home page. A value that is not a literal is judged where it runs.
 */
export const checkGuidedTask = (
  node: Extract<FlowTask, { properties: unknown }>,
  report: Report,
): void => {
  const properties = node.properties as Readonly<Record<string, FlowValue>>;
  if (node.type === "interface.verify") {
    const requires = literalOf(properties.requires);
    if (
      properties.requires?.kind === "literal" &&
      !(flowVerificationRequirements as readonly unknown[]).includes(requires)
    )
      report("requires", `A Verify step asks for ${flowVerificationRequirements.join(" or ")}`);
  }
  if (node.type === "interface.wizard" && properties.steps?.kind === "literal") {
    const steps = literalOf(properties.steps);
    const current = literalOf(properties.step);
    const valid =
      Array.isArray(steps) &&
      steps.length >= 2 &&
      steps.length <= maximumFlowWizardSteps &&
      steps.every((entry) => typeof entry === "string" && entry.trim().length > 0) &&
      new Set(steps).size === steps.length;
    if (!valid)
      report("steps", `The steps are a list of 2 to ${maximumFlowWizardSteps} different names`);
    else if (typeof current === "string" && !steps.includes(current))
      report("step", "The current step is one of the listed steps");
  }
  if (node.type === "interface.navigate") {
    const named = [properties.page, properties.application, properties.application_root].filter(
      (value) => value !== undefined,
    ).length;
    if (named === 0)
      report("page", "A Navigate step names a page, or another application to open", true);
    else if (properties.application_root !== undefined && named > 1)
      report(
        "application_root",
        "A Navigate step that opens an application by its identity names no page and no key",
      );
  }
};
