import { builderKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";
import { applicationUses, type ApplicationUsePlace } from "./application-uses";
import { fullRecordAccessRoleKeys } from "./module-permission-shape";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type ModuleAction = InlineModule["actions"][number];
type ModulePermission = InlineModule["permissions"][number];
type ModuleFlow = InlineModule["flows"][number];

/** A named action's precondition: the authored condition tree a module action holds. */
export type InlineModuleActionPrecondition = NonNullable<ModuleAction["precondition"]>;

/** One field the action's flow sets, and the authored value it sets it to. */
type InlineModuleActionEffect = Readonly<{ field: string; value: unknown }>;

/**
 * A named action of an owned Module's record type as Studio edits it: its label, when it may run,
 * its inputs, the permission that gates it and whether it owns the choice option its flow sets.
 * Saving that option anywhere else (a form, a board card, a Save record step) then runs this action.
 * What the action does is its flow, edited in the flow editor.
 */
export type InlineModuleActionChange = Readonly<{
  moduleKey: string;
  recordKey: string;
  /** The action's key; absent for a new action. */
  actionKey?: string;
  label: string;
  precondition: InlineModuleActionPrecondition | undefined;
  inputs: ModuleAction["inputs"];
  /** The action's own permission (created with it), or another named permission of its record type. */
  permission: Readonly<{ kind: "own" }> | Readonly<{ kind: "existing"; key: string }>;
  ownsChoice: boolean;
  /** A new action's first step: sets this choice field to this option. */
  initialEffect?: Readonly<{ field: string; option: string }>;
}>;

export type InlineModuleActionResult =
  | Readonly<{
      kind: "changed";
      source: ApplicationSourceDocument;
      actionKey: string;
      /** The action's flow, which the flow editor opens. */
      flowAlias?: string;
    }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>
  /** A permission the change would leave behind is still used elsewhere; nothing was changed. */
  | Readonly<{ kind: "referenced"; issue: string; references: readonly ApplicationUsePlace[] }>;

const nameFrom = (label: string): string => {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (/^[a-z]/.test(words) ? words : `action_${words}`).slice(0, 40).replace(/_+$/, "");
};

const uniqueAlias = (base: string, taken: ReadonlySet<string>): string => {
  const trimmed = base.slice(0, 150);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? trimmed : `${trimmed}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const moduleAliases = (module: InlineModule): Set<string> =>
  new Set([
    module.id,
    ...module.record_types.flatMap((record) => [
      record.id,
      record.storage_contract_id,
      ...record.fields.map((field) => field.id),
      ...record.relationships.map((relationship) => relationship.id),
    ]),
    ...module.permissions.map((permission) => permission.id),
    ...module.actions.map((action) => action.id),
    ...module.flows.map((flow) => flow.id),
    ...module.events.map((event) => event.id),
    ...module.queries.map((query) => query.id),
  ]);

/** The fields an authored condition reads, by key. */
const conditionFields = (condition: unknown): string[] => {
  if (condition === null || typeof condition !== "object") return [];
  const node = condition as Record<string, unknown>;
  if (Array.isArray(node.all)) return node.all.flatMap(conditionFields);
  if (Array.isArray(node.any)) return node.any.flatMap(conditionFields);
  if (node.not !== undefined) return conditionFields(node.not);
  const operands = [node.left, node.right].flatMap((operand) =>
    operand !== null &&
    typeof operand === "object" &&
    (operand as Record<string, unknown>).source === "field"
      ? [String((operand as Record<string, unknown>).field)]
      : [],
  );
  return [...(typeof node.field === "string" ? [node.field] : []), ...operands];
};

/** The text of a fixed value, when an effect sets one. */
const fixedText = (value: unknown): string | undefined => {
  const entry = value as { kind?: string; literal?: { value?: unknown } } | null;
  return entry?.kind === "literal" && typeof entry.literal?.value === "string"
    ? entry.literal.value
    : undefined;
};

const initialEffectValue = (effect: Readonly<{ field: string; option: string }>) => ({
  kind: "literal",
  literal: { type: "choice", value: effect.option },
});

/** The `record.set_fields` entries of one authored flow, in task order. */
const flowEffects = (flow: ModuleFlow | undefined): InlineModuleActionEffect[] =>
  (flow?.tasks ?? []).flatMap((task) =>
    task.type === "record.set_fields"
      ? Object.entries(
          (task.properties as { values?: { entries?: Record<string, unknown> } }).values?.entries ??
            {},
        ).map(([field, value]) => ({ field, value }))
      : [],
  );

/** The one choice field and option the effects set, when the action can own that option. */
const ownedOption = (
  record: RecordType,
  effects: readonly InlineModuleActionEffect[],
): Readonly<{ field: string; option: string }> | undefined => {
  const choices = effects.filter(
    (effect) => record.fields.find((field) => field.key === effect.field)?.type === "choice",
  );
  const first = choices[0];
  const option = first === undefined ? undefined : fixedText(first.value);
  return first === undefined ||
    option === undefined ||
    !choices.every((effect) => effect.field === first.field && fixedText(effect.value) === option)
    ? undefined
    : { field: first.field, option };
};

const actionFlowInputs = (
  recordKey: string,
  inputs: ModuleAction["inputs"],
): ModuleFlow["inputs"] => ({
  record: {
    type: "record_reference",
    required: true,
    recordTypeIds: [recordKey],
    description: "The record the action runs on.",
  },
  ...Object.fromEntries(
    inputs.map((input) => [
      input.key,
      {
        type: input.type,
        required: input.required,
        ...(input.type === "record_reference" ? { recordTypeIds: input.record_types } : {}),
      },
    ]),
  ),
});

/** A new action's flow: the record input and the action's inputs, and nothing done yet. */
const starterActionFlow = (
  id: string,
  key: string,
  recordKey: string,
  inputs: ModuleAction["inputs"],
  effect?: Readonly<{ field: string; option: string }>,
): ModuleFlow =>
  ({
    id,
    key,
    labels: {},
    execution: "transaction",
    runAs: { kind: "saver" },
    inputs: actionFlowInputs(recordKey, inputs),
    recordInput: "record",
    variables: {},
    triggers: [],
    tasks:
      effect === undefined
        ? [{ id: "done", type: "stop", outcome: "completed" }]
        : [
            {
              id: "set_fields",
              type: "record.set_fields",
              version: "1.0.0",
              properties: {
                values: {
                  kind: "map",
                  entries: { [effect.field]: initialEffectValue(effect) },
                },
              },
            },
          ],
    outputs: {},
    errors: [],
    finally: [],
  }) as unknown as ModuleFlow;

/**
 * What an action's own permission reads and changes: the fields its condition and its flow read of
 * the record, the fields its flow sets, the carried fields of the events it announces and the link
 * fields of the relationships it copies.
 */
export const actionFieldPolicy = (
  module: InlineModule,
  record: RecordType,
  action: ModuleAction,
): Readonly<{ readable_fields: string[]; changeable_fields: string[] }> => {
  const flow = module.flows.find((candidate) => candidate.id === action.flow);
  const effects = flowEffects(flow);
  const readFields = new Set([
    ...conditionFields(action.precondition),
    ...effects.map((effect) => effect.field),
  ]);
  const collectReads = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (
      "source" in value &&
      value.source === "trigger_record" &&
      "field" in value &&
      typeof value.field === "string"
    )
      readFields.add(value.field);
    for (const entry of Object.values(value)) collectReads(entry);
  };
  collectReads(flow?.tasks);
  for (const task of flow?.tasks ?? []) {
    const properties = (task as { properties?: Record<string, unknown> }).properties ?? {};
    if (task.type === "event.announce")
      for (const key of module.events.find((event) => event.key === fixedText(properties.event))
        ?.carries ?? [])
        readFields.add(key);
    if (task.type === "record.changes") {
      const changes = (properties.changes as { literal?: { value?: unknown } } | undefined)?.literal
        ?.value;
      for (const item of Array.isArray(changes) ? changes : [])
        for (const key of (item as { relationshipIds?: string[] }).relationshipIds ?? []) {
          const field = record.relationships.find(
            (relationship) => relationship.key === key,
          )?.from_field;
          if (field !== undefined) readFields.add(field);
        }
    }
  }
  return {
    readable_fields: [...readFields],
    changeable_fields: [...new Set(effects.map((effect) => effect.field))],
  };
};

const parsed = (
  source: ApplicationSourceDocument,
  actionKey: string,
  flowAlias?: string,
): InlineModuleActionResult => {
  const result = applicationSourceDocumentSchema.safeParse(source);
  return result.success
    ? {
        kind: "changed",
        source: result.data,
        actionKey,
        ...(flowAlias === undefined ? {} : { flowAlias }),
      }
    : {
        kind: "invalid",
        issues: result.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`),
      };
};

/**
 * Creates or changes one named action of an owned Module's record type. A new action gets its own
 * named permission, granted only to roles holding every existing record permission across the
 * Application's owned Modules; its permission follows the fields the action reads and sets. The ordered tasks and typed inputs are edited in their existing source contract.
 */
export const saveInlineModuleAction = (
  current: ApplicationSourceDocument,
  change: InlineModuleActionChange,
): InlineModuleActionResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  const record = module?.record_types.find((item) => item.key === change.recordKey);
  if (module === undefined || record === undefined)
    return {
      kind: "invalid",
      issues: ["The record type is not in this application's modules any more."],
    };
  const label = change.label.trim();
  const issues: string[] = [];
  if (label.length < 1 || label.length > 60)
    issues.push("Name: give the action a name of at most 60 characters, such as Mark won.");
  const existing =
    change.actionKey === undefined
      ? undefined
      : module.actions.find((action) => action.key === change.actionKey);
  if (change.actionKey !== undefined && existing === undefined)
    return { kind: "invalid", issues: ["This action is not in the module any more."] };
  if (existing !== undefined && existing.record_type !== record.key)
    return { kind: "invalid", issues: ["This action belongs to another record type."] };
  if (existing?.protected_operation !== undefined)
    return {
      kind: "invalid",
      issues: [
        "This action runs a registered operation of the platform, so what it sets is not changed here.",
      ],
    };
  const existingFlow =
    existing === undefined
      ? undefined
      : module.flows.find((candidate) => candidate.id === existing.flow);
  const effects: InlineModuleActionEffect[] =
    existingFlow !== undefined
      ? flowEffects(existingFlow)
      : change.initialEffect === undefined
        ? []
        : [{ field: change.initialEffect.field, value: initialEffectValue(change.initialEffect) }];
  for (const input of change.inputs)
    if (input.type === "record_reference")
      for (const reference of input.record_types) {
        const [owner, key] = reference.split(":");
        if (
          !source.body.modules.some(
            (module) =>
              module.key === owner && module.record_types.some((record) => record.key === key),
          ) &&
          !source.body.uses.some((used) => used.module === owner)
        )
          issues.push(`Input ${input.label}: choose a record type in this application.`);
      }
  if (new Set(change.inputs.map((input) => input.key)).size !== change.inputs.length)
    issues.push("Inputs: give each input a unique key.");
  const precondition = change.precondition;
  for (const field of conditionFields(precondition))
    if (!record.fields.some((candidate) => candidate.key === field))
      issues.push(`Runs only when: ${record.name} has no field ${field}.`);
  const owned = change.ownsChoice ? ownedOption(record, effects) : undefined;
  if (change.ownsChoice && owned === undefined)
    issues.push(
      "Owns the choice: the action must set exactly one choice field to one fixed option to own it.",
    );
  if (owned !== undefined) {
    const rival = module.actions.find(
      (action) =>
        action !== existing &&
        action.record_type === record.key &&
        action.sets_choice_field === owned.field &&
        action.sets_choice_option === owned.option,
    );
    if (rival !== undefined)
      issues.push(
        `Owns the choice: ${rival.label} already owns this option. Only one action can own it.`,
      );
  }
  const name =
    existing === undefined ? undefined : existing.key.slice(existing.key.lastIndexOf(".") + 1);
  const taken = moduleAliases(module);
  const flowKeys = new Set(module.flows.map((flow) => flow.key));
  const keys = new Set([
    ...module.actions.map((action) => action.key),
    ...module.permissions.map((permission) => permission.key),
  ]);
  const newName =
    name ??
    (() => {
      const base = nameFrom(label);
      for (let n = 1; n < 1_000; n += 1) {
        const candidate = n === 1 ? base : `${base.slice(0, 36)}_${n}`;
        if (!keys.has(`${module.key}.${record.key}.${candidate}`)) return candidate;
      }
      return base;
    })();
  if (!builderKeySchema.safeParse(newName).success)
    issues.push("Name: start the name with a letter, such as Mark won.");
  let permissionKey: string;
  if (change.permission.kind === "existing") {
    const chosen = module.permissions.find(
      (permission) => permission.key === (change.permission as { key: string }).key,
    );
    if (chosen === undefined || chosen.action_kind !== "named" || chosen.record_type !== record.key)
      issues.push(`Permission: choose a named permission of ${record.plural_name}.`);
    permissionKey = chosen?.key ?? "";
  } else
    permissionKey =
      existing?.permission !== undefined && existing.permission === existing.key
        ? existing.permission
        : `${module.key}.${record.key}.${newName}`;
  if (issues.length > 0) return { kind: "invalid", issues };

  const actionKey = existing?.key ?? `${module.key}.${record.key}.${newName}`;
  // No orphan permissions: an action that moves off its own permission takes it away, unless
  // something else still uses it, which refuses the change with where.
  const ownBefore = module.permissions.find((permission) => permission.key === actionKey);
  if (
    change.permission.kind === "existing" &&
    existing !== undefined &&
    existing.permission === actionKey &&
    ownBefore !== undefined
  ) {
    const references = permissionReferences(source, module, actionKey, existing);
    if (references.length > 0)
      return {
        kind: "referenced",
        references,
        issue: `Permission: the action's own permission is still used in ${references.length === 1 ? "one place" : `${references.length} places`}, so it cannot be left behind. Remove those uses first.`,
      };
    module.permissions = module.permissions.filter((permission) => permission !== ownBefore);
    for (const role of source.body.roles)
      (role as { permissions: string[] }).permissions = (role.permissions as string[]).filter(
        (entry) => entry !== actionKey,
      );
  }
  const actionId = existing?.id ?? uniqueAlias(`act_${record.key}_${newName}`, taken);
  const flowId = existing?.flow ?? uniqueAlias(`flow_${actionId.slice(4)}`, taken);
  const flowKey = uniqueAlias(`${record.key}_${newName}`.slice(0, 32).replace(/_+$/, ""), flowKeys);
  const action = {
    ...existing,
    id: actionId,
    key: actionKey,
    label,
    record_type: record.key,
    permission: permissionKey,
    shareable: existing?.shareable ?? false,
    inputs: structuredClone(change.inputs),
    ...(precondition === undefined ? {} : { precondition: structuredClone(precondition) }),
    flow: flowId,
    ...(owned === undefined
      ? {}
      : { sets_choice_field: owned.field, sets_choice_option: owned.option }),
  } as unknown as ModuleAction;
  if (precondition === undefined) delete action.precondition;
  if (owned === undefined) {
    delete action.sets_choice_field;
    delete action.sets_choice_option;
  }
  if (existing === undefined) {
    module.actions.push(action);
    (record.custom_actions as string[]).push(action.id);
    module.flows.push(
      starterActionFlow(flowId, flowKey, record.key, change.inputs, change.initialEffect),
    );
  } else {
    module.actions[module.actions.indexOf(existing)] = action;
    if (existingFlow !== undefined)
      existingFlow.inputs = actionFlowInputs(record.key, change.inputs);
  }

  const { readable_fields: readable, changeable_fields: changeable } = actionFieldPolicy(
    module,
    record,
    action,
  );
  const own = module.permissions.find((permission) => permission.key === actionKey);
  if (change.permission.kind === "own") {
    const policy = { readable_fields: readable, changeable_fields: changeable };
    if (own === undefined) {
      const fullAccessRoles = fullRecordAccessRoleKeys(current);
      module.permissions.push({
        id: uniqueAlias(`perm_${record.key}_${newName}`, taken),
        key: actionKey,
        label: `${label} (${record.name})`.slice(0, 60),
        description: `Allows the ${label} action on ${record.plural_name.toLowerCase()}.`.slice(
          0,
          1_000,
        ),
        record_type: record.key,
        action_kind: "named",
        named_action: newName,
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: policy,
      } as unknown as ModulePermission);
      for (const role of source.body.roles) {
        const entries = role.permissions as string[];
        if (fullAccessRoles.has(role.key) && !entries.includes("*") && !entries.includes(actionKey))
          entries.push(actionKey);
      }
    } else if (
      existing === undefined ||
      JSON.stringify(existing.precondition) !== JSON.stringify(precondition)
    )
      (own as { field_policy?: unknown }).field_policy = policy;
  }
  return parsed(source, actionKey, flowId);
};

/**
 * Every place that uses an action's own permission besides the access groups that hold it, the
 * module's permissions and the action itself, which all let it go with the permission.
 */
const permissionReferences = (
  source: ApplicationSourceDocument,
  module: InlineModule,
  key: string,
  action: ModuleAction,
): readonly ApplicationUsePlace[] => {
  const moduleIndex = source.body.modules.indexOf(module);
  const actionIndex = module.actions.indexOf(action);
  return applicationUses(
    source,
    { kind: "permission", permissionKey: key },
    (path) =>
      path[1] === "roles" ||
      (path[1] === "modules" &&
        path[2] === moduleIndex &&
        (path[3] === "permissions" || (path[3] === "actions" && path[4] === actionIndex))),
  );
};

/**
 * The Application source without one named action. It is refused while a flow, board or block still
 * runs it. Its own permission goes with it, from the module and from every access group.
 */
export const deleteInlineModuleAction = (
  current: ApplicationSourceDocument,
  moduleKey: string,
  actionKey: string,
):
  | InlineModuleActionResult
  | Readonly<{ kind: "referenced"; references: readonly ApplicationUsePlace[] }> => {
  const references = applicationUses(current, { kind: "action", moduleKey, actionKey });
  if (references.length > 0) return { kind: "referenced", references };
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const action = module?.actions.find((item) => item.key === actionKey);
  if (module === undefined || action === undefined)
    return { kind: "invalid", issues: ["This action is not in the module any more."] };
  module.actions = module.actions.filter((item) => item !== action);
  for (const record of module.record_types)
    (record as { custom_actions: string[] }).custom_actions = (
      record.custom_actions as string[]
    ).filter((id) => id !== action.id);
  const ownPermission = action.permission === actionKey;
  if (ownPermission) {
    module.permissions = module.permissions.filter((permission) => permission.key !== actionKey);
    for (const role of source.body.roles)
      (role as { permissions: string[] }).permissions = (role.permissions as string[]).filter(
        (entry) => entry !== actionKey,
      );
  }
  return parsed(source, actionKey);
};
