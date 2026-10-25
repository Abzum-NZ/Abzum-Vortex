import {
  applicationSourceDocumentSchema,
  flowTaskRegistry,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
  isRecord as isObject,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import { studioFlowLabel } from "./semantic-selection";

const refuse = (): never => {
  throw new TypeError("Composition edit refused");
};
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) return refuse();
  return value;
};

export type StudioCompositionRemovalReason =
  | "flow_input"
  | "flow_form"
  | "flow_component"
  | "flow_panel"
  | "required_slot"
  | "required_field"
  | "content_outlet"
  | "unresolved_target";

/** What still names a placement, with the flow and step that do when one does. */
export type StudioPlacementReference = Readonly<{
  reason: StudioCompositionRemovalReason;
  flow?: string;
  step?: string;
}>;

/** Where a flow still names an item, as a sentence a person can act on. */
export const studioPlacementReferenceSentence = (reference: StudioPlacementReference): string => {
  const where =
    reference.flow === undefined
      ? "A flow"
      : reference.step === undefined
        ? `Flow "${reference.flow}"`
        : `Flow "${reference.flow}", step "${reference.step}"`;
  switch (reference.reason) {
    case "required_field":
      return "This item holds an input for a required field. Make the field optional in Data, or clear the input's Required setting, first.";
    case "flow_input":
      return `${where} reads this form input. Change its input mapping first.`;
    case "flow_form":
      return `${where} shows this form. Change that step first.`;
    case "flow_component":
      return `${where} refreshes or filters this item. Change that step first.`;
    case "flow_panel":
      return `${where} opens this panel. Change that step first.`;
    default:
      return `${where} names something this item points to that cannot be found. Change that step first.`;
  }
};

/** Every `id` in the source: a new block's name is unique among them all. */
export const sourceNames = (source: ApplicationSourceDocument): Set<string> => {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    if (typeof value.id === "string") names.add(value.id);
    Object.values(value).forEach(visit);
  };
  visit(source);
  return names;
};

/**
 * The flow task that still targets a placement, read only from declared placement identity
 * positions, never arbitrary literal data. `aliases` is every placement in the application. The
 * placement's own flow bindings are not a reference: they leave with it (removeFlowBindingsOf).
 */
export const studioPlacementRemovalReference = (
  source: ApplicationSourceDocument,
  alias: string,
  aliases: ReadonlySet<string>,
): StudioPlacementReference | undefined => {
  const target = (
    value: unknown,
    qualified: boolean,
    reason: StudioCompositionRemovalReason,
  ): StudioCompositionRemovalReason | undefined => {
    if (typeof value !== "string") return "unresolved_target";
    const separator = value.indexOf(":");
    if (
      separator !== -1 &&
      (!qualified || separator < 1 || value.slice(0, separator) !== source.key)
    )
      return "unresolved_target";
    const local = value.slice(separator + 1);
    if (
      !applicationSourceDocumentSchema.shape.root_alias.safeParse(local).success ||
      !aliases.has(local)
    )
      return "unresolved_target";
    return local === alias ? reason : undefined;
  };
  const literalTarget = (
    value: unknown,
    qualified: boolean,
    reason: StudioCompositionRemovalReason,
  ): StudioCompositionRemovalReason | undefined => {
    if (
      !isObject(value) ||
      value.kind !== "literal" ||
      !isObject(value.literal) ||
      value.literal.type !== "text"
    )
      return "unresolved_target";
    return target(value.literal.value, qualified, reason);
  };
  const list = (value: unknown): readonly unknown[] => {
    if (!Array.isArray(value)) return refuse();
    return value;
  };
  const definitions = Object.values(flowTaskRegistry);
  for (const flow of source.body.flows) {
    const flowName = studioFlowLabel(flow);
    // These are authored SourceFlow lists, not the compiled Flow body's shape.
    const pending = [...flow.tasks, ...flow.errors, ...flow.finally].map((task) => ({
      task: object(task),
      depth: 1,
    }));
    let count = 0;
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (++count > flowMaximumTaskCount || entry.depth > flowMaximumTaskNestingDepth)
        return { reason: "unresolved_target", flow: flowName };
      const task = entry.task;
      const definition = definitions.find((candidate) => candidate.type === task.type);
      const at = (reason: StudioCompositionRemovalReason): StudioPlacementReference => ({
        reason,
        flow: flowName,
        step:
          typeof task.description === "string"
            ? task.description
            : (definition?.title ?? String(task.type)),
      });
      if (definition === undefined) return at("unresolved_target");
      const children: (readonly unknown[])[] = [];
      if (definition.category === "control") {
        switch (task.type) {
          case "if":
            children.push(list(task.then));
            if (task.else !== undefined) children.push(list(task.else));
            break;
          case "switch":
            for (const branch of list(task.cases)) children.push(list(object(branch).tasks));
            if (task.default !== undefined) children.push(list(task.default));
            break;
          case "for_each":
          case "sequential":
            children.push(list(task.tasks));
            break;
          case "parallel":
            for (const branch of list(task.branches)) children.push(list(branch));
            break;
          case "wait_for_person": {
            const blocked = target(task.formId, true, "flow_form");
            if (blocked !== undefined) return at(blocked);
            break;
          }
          case "run_flow":
          case "stop":
          case "wait_until":
            break;
          default:
            return at("unresolved_target");
        }
      } else {
        if (task.version !== definition.version || !isObject(task.properties))
          return at("unresolved_target");
        for (const [key, declaration] of Object.entries(definition.properties)) {
          const reason =
            declaration.type === "form_id"
              ? "flow_form"
              : (task.type === "interface.refresh" || task.type === "interface.set_filter") &&
                  key === "component"
                ? "flow_component"
                : task.type === "interface.set_panel" && key === "panel"
                  ? "flow_panel"
                  : undefined;
          if (reason === undefined) continue;
          const value = task.properties[key];
          if (value === undefined && !declaration.required) continue;
          const blocked = literalTarget(value, declaration.type === "form_id", reason);
          if (blocked !== undefined) return at(blocked);
        }
      }
      for (const child of children)
        for (const nested of child) pending.push({ task: object(nested), depth: entry.depth + 1 });
    }
  }
  return undefined;
};

export const sameCompositionValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, index: number) => sameCompositionValue(value, right[index]))
    );
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameCompositionValue(left[key], right[key]))
  );
};
