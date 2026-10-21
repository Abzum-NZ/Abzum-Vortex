/**
 * The one judgement of a declared dependency between fields of a record type. A link field's
 * choices are the records of its target whose `filter` link points at the record chosen in its
 * `parent` link field (Country -> Region -> City). A choice field's options are those that list the
 * option chosen in its `parent` choice field among their parent values. Studio asks it while a
 * field is edited and the publish rules ask it of the compiled module, each handing over its
 * fields in this one shape, so both refuse the same declarations in the same words.
 */
export type LinkDependencyField = Readonly<{
  /** The field's identity in the shape the caller holds it (a key in the source, an id compiled). */
  id: string;
  label: string;
  type: string;
  filterable: boolean;
  /** The identity of the one record type a single-target link points at. */
  target?: string;
  /** A link child names the `filter` link of its target; a choice child names none. */
  dependsOn?: Readonly<{ parent: string; filter?: string }>;
  /** A choice field's options, each with the parent options it belongs to when it depends on one. */
  options?: readonly Readonly<{ value: string; parentValues?: readonly string[] }>[];
}>;

export type LinkDependencyProblem = Readonly<{
  reason:
    | "not_dependable"
    | "parent_missing"
    | "loop"
    | "order"
    | "filter_unavailable"
    | "parent_not_a_choice"
    | "option_parents";
  message: string;
}>;

export type LinkDependencyCandidates =
  | Readonly<{
      kind: "available";
      parents: readonly LinkDependencyField[];
      filtersByParent: Readonly<Record<string, readonly LinkDependencyField[]>>;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: "no_parent_link" | "no_matching_link" | "not_filterable";
      message: string;
      /** The target field to open when filtering needs enabling. Otherwise open its record type. */
      fieldId?: string;
    }>;

const matchingLink = (parent: LinkDependencyField, filter: LinkDependencyField): boolean =>
  parent.type === "link" &&
  parent.target !== undefined &&
  filter.type === "link" &&
  filter.target === parent.target;

/** Offer only pairs accepted by the dependency judgement, with an actionable reason otherwise. */
export const linkDependencyCandidates = (
  fields: readonly LinkDependencyField[],
  field: LinkDependencyField & Readonly<{ recordLabel: string; targetLabel: string }>,
  targetFields: readonly LinkDependencyField[],
): LinkDependencyCandidates => {
  const position = fields.findIndex((item) => item.id === field.id);
  const ordered =
    position < 0 ? [...fields, field] : fields.map((item) => (item.id === field.id ? field : item));
  const parents = ordered
    .slice(0, ordered.indexOf(field))
    .filter((item) => item.type === "link" && item.target !== undefined);
  if (parents.length === 0)
    return {
      kind: "unavailable",
      reason: "no_parent_link",
      message: `Add another link to ${field.recordLabel} before this one; its choice can then narrow ${field.label}'s choices.`,
    };
  const filtersByParent: Record<string, readonly LinkDependencyField[]> = Object.create(null);
  for (const parent of parents) {
    const filters = targetFields.filter(
      (filter) =>
        matchingLink(parent, filter) &&
        filter.filterable &&
        linkDependencyProblem(
          ordered.map((item) =>
            item.id === field.id
              ? { ...field, dependsOn: { parent: parent.id, filter: filter.id } }
              : item,
          ),
          field.id,
          targetFields,
        ) === undefined,
    );
    if (filters.length > 0) filtersByParent[parent.id] = filters;
  }
  const availableParents = parents.filter((parent) => filtersByParent[parent.id] !== undefined);
  if (availableParents.length > 0)
    return { kind: "available", parents: availableParents, filtersByParent };
  for (const parent of parents) {
    const filter = targetFields.find((item) => matchingLink(parent, item) && !item.filterable);
    if (filter !== undefined)
      return {
        kind: "unavailable",
        reason: "not_filterable",
        fieldId: filter.id,
        message: `${field.targetLabel}'s ${filter.label} link does not allow filtering. Turn on Allow filtering for ${filter.label} on ${field.targetLabel} to use it here.`,
      };
  }
  return {
    kind: "unavailable",
    reason: "no_matching_link",
    message: `${field.targetLabel} has no link to ${parents[0]!.label} to narrow by. Add one to ${field.targetLabel} first.`,
  };
};

/**
 * Why `fieldId`'s declared dependency cannot hold, or undefined when it can. `fields` are the
 * record type's fields in their draft order; `targetFields` are the fields of the record type the
 * field links to, which the dependency filters.
 */
export const linkDependencyProblem = (
  fields: readonly LinkDependencyField[],
  fieldId: string,
  targetFields: readonly LinkDependencyField[] | undefined,
): LinkDependencyProblem | undefined => {
  const child = fields.find((field) => field.id === fieldId);
  const dependsOn = child?.dependsOn;
  if (child === undefined || dependsOn === undefined) return undefined;
  const parent = fields.find((field) => field.id === dependsOn.parent);
  const isChoice = child.type === "choice";
  if (!isChoice && (child.type !== "link" || child.target === undefined))
    return {
      reason: "not_dependable",
      message: `${child.label} can depend on another field only when it is a choice or links to one record type.`,
    };
  if (parent === undefined)
    return {
      reason: "parent_missing",
      message: `${child.label} depends on a field that is not in this record type.`,
    };
  // Follow the parents upwards: reaching this field again is a loop, whatever the order.
  const seen = new Set<string>([child.id]);
  const byId = new Map(fields.map((field) => [field.id, field]));
  let step: LinkDependencyField | undefined = parent;
  while (step !== undefined) {
    if (seen.has(step.id)) return { reason: "loop", message: "Dependencies cannot loop." };
    seen.add(step.id);
    step = step.dependsOn === undefined ? undefined : byId.get(step.dependsOn.parent);
  }
  if (fields.indexOf(parent) > fields.indexOf(child))
    return {
      reason: "order",
      message: `Not possible - ${child.label} depends on ${parent.label}, which comes after it.`,
    };
  if (isChoice) {
    if (parent.type !== "choice")
      return {
        reason: "parent_not_a_choice",
        message: `${child.label} can depend only on a choice field, and ${parent.label} is not one.`,
      };
    const parentValues = new Set((parent.options ?? []).map((option) => option.value));
    for (const option of child.options ?? [])
      if (
        option.parentValues === undefined ||
        option.parentValues.length === 0 ||
        option.parentValues.some((value) => !parentValues.has(value))
      )
        return {
          reason: "option_parents",
          message: `Every option of ${child.label} must say which ${parent.label} options it belongs to.`,
        };
    return undefined;
  }
  const filter = targetFields?.find((field) => field.id === dependsOn.filter);
  if (filter === undefined || !filter.filterable || !matchingLink(parent, filter))
    return {
      reason: "filter_unavailable",
      message: `${child.label} cannot be filtered by ${parent.label}: choose a field the list can filter by.`,
    };
  return undefined;
};
