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

/** Why a flow, or the block itself, still names a placement. */
export type StudioPlacementReferenceReason =
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
  reason: StudioPlacementReferenceReason;
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
      return "This item holds an input for a required field with no default value, so a new record could not be saved without it. Make the field optional or give it a default in Data, or clear the input's Required setting, first.";
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

/** What a flow task's target position holds: a placement alias, or something that cannot be resolved. */
type FlowTarget =
  "unresolved_target" | Readonly<{ local: string; reason: StudioPlacementReferenceReason }>;

/**
 * The flow task that targets each placement, read only from declared placement identity
 * positions, never arbitrary literal data, with one scan of the flows. `aliases` is every
 * placement in the application. The placement's own flow bindings are not a reference: they leave
 * with it (removeFlowBindingsOf). The answer for an alias is the first thing the scan found that
 * names it or cannot be resolved at all (which blocks every placement).
 */
export const studioPlacementRemovalReferences = (
  source: ApplicationSourceDocument,
  aliases: ReadonlySet<string>,
): ((alias: string) => StudioPlacementReference | undefined) => {
  const target = (
    value: unknown,
    qualified: boolean,
    reason: StudioPlacementReferenceReason,
  ): FlowTarget => {
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
    return { local, reason };
  };
  const literalTarget = (
    value: unknown,
    qualified: boolean,
    reason: StudioPlacementReferenceReason,
  ): FlowTarget => {
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
  // Findings in the order the scan made them; the scan ends at the first one that blocks every alias.
  const hits = new Map<string, { reference: StudioPlacementReference; order: number }>();
  let blocking: { reference: StudioPlacementReference; order: number } | undefined;
  let order = 0;
  const definitions = Object.values(flowTaskRegistry);
  scan: for (const flow of source.body.flows) {
    const flowName = studioFlowLabel(flow);
    // These are authored SourceFlow lists, not the compiled Flow body's shape.
    const pending = [...flow.tasks, ...flow.errors, ...flow.finally].map((task) => ({
      task: object(task),
      depth: 1,
    }));
    let count = 0;
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (++count > flowMaximumTaskCount || entry.depth > flowMaximumTaskNestingDepth) {
        blocking = { reference: { reason: "unresolved_target", flow: flowName }, order: order++ };
        break scan;
      }
      const task = entry.task;
      const definition = definitions.find((candidate) => candidate.type === task.type);
      const at = (reason: StudioPlacementReferenceReason): StudioPlacementReference => ({
        reason,
        flow: flowName,
        step:
          typeof task.description === "string"
            ? task.description
            : (definition?.title ?? String(task.type)),
      });
      const block = (): void => {
        blocking = { reference: at("unresolved_target"), order: order++ };
      };
      if (definition === undefined) {
        block();
        break scan;
      }
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
          case "run_flow":
          case "stop":
            break;
          default:
            block();
            break scan;
        }
      } else {
        if (task.version !== definition.version || !isObject(task.properties)) {
          block();
          break scan;
        }
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
          const found = literalTarget(value, declaration.type === "form_id", reason);
          if (found === "unresolved_target") {
            block();
            break scan;
          }
          if (!hits.has(found.local))
            hits.set(found.local, { reference: at(found.reason), order: order++ });
        }
      }
      for (const child of children)
        for (const nested of child) pending.push({ task: object(nested), depth: entry.depth + 1 });
    }
  }
  return (alias) => {
    const hit = hits.get(alias);
    if (hit !== undefined && (blocking === undefined || hit.order < blocking.order))
      return hit.reference;
    return blocking?.reference;
  };
};

/** The flow task that still targets one placement; `studioPlacementRemovalReferences` for many. */
export const studioPlacementRemovalReference = (
  source: ApplicationSourceDocument,
  alias: string,
  aliases: ReadonlySet<string>,
): StudioPlacementReference | undefined => studioPlacementRemovalReferences(source, aliases)(alias);

/**
 * Whether two values hold the same data. With `emptyListIsAbsent`, a slot with nothing in it and a
 * slot that is not there are the same (Puck fills every slot it knows with an empty list, so
 * Puck's data and the draft's data for one page differ in nothing else). Slots are direct keys of
 * an item's props, which are the objects that hold `vortex`; a list inside a setting is data.
 */
export const sameCompositionValue = (
  left: unknown,
  right: unknown,
  emptyListIsAbsent = false,
): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, index: number) =>
        sameCompositionValue(value, right[index], emptyListIsAbsent),
      )
    );
  if (!isObject(left) || !isObject(right)) return false;
  const slotLevel =
    emptyListIsAbsent && (Object.hasOwn(left, "vortex") || Object.hasOwn(right, "vortex"));
  const present = (value: unknown): boolean =>
    value !== undefined && !(slotLevel && Array.isArray(value) && value.length === 0);
  const keys = Object.keys(left).filter((key) => present(left[key]));
  return (
    keys.length === Object.keys(right).filter((key) => present(right[key])).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && sameCompositionValue(left[key], right[key], emptyListIsAbsent),
    )
  );
};
