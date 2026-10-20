import {
  applicationSourceDocumentSchema,
  flowTaskRegistry,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
  isRecord as isObject,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";

const refuse = (): never => {
  throw new TypeError("Composition edit refused");
};
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) return refuse();
  return value;
};

export type StudioCompositionRemovalReason =
  | "flow_control"
  | "flow_form"
  | "flow_component"
  | "flow_panel"
  | "required_slot"
  | "unresolved_target";

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
 * What still names a placement (its flow bindings, or a flow task that targets it), read only from
 * declared placement identity positions, never arbitrary literal data. `aliases` is every placement
 * in the application.
 */
export const studioPlacementRemovalReference = (
  source: ApplicationSourceDocument,
  alias: string,
  aliases: ReadonlySet<string>,
): StudioCompositionRemovalReason | undefined => {
  if (source.body.flow_bindings.some((binding) => binding.control === alias)) return "flow_control";
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
    // These are authored SourceFlow lists, not the compiled Flow body's shape.
    const pending = [...flow.tasks, ...flow.errors, ...flow.finally].map((task) => ({
      task: object(task),
      depth: 1,
    }));
    let count = 0;
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (++count > flowMaximumTaskCount || entry.depth > flowMaximumTaskNestingDepth)
        return "unresolved_target";
      const task = entry.task;
      const definition = definitions.find((candidate) => candidate.type === task.type);
      if (definition === undefined) return "unresolved_target";
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
            if (blocked !== undefined) return blocked;
            break;
          }
          case "run_flow":
          case "stop":
          case "wait_until":
            break;
          default:
            return "unresolved_target";
        }
      } else {
        if (task.version !== definition.version || !isObject(task.properties))
          return "unresolved_target";
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
          if (blocked !== undefined) return blocked;
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
